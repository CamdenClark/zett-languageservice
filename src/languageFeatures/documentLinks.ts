/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from 'vscode-languageserver';
import * as lsp from 'vscode-languageserver-types';
import * as nls from 'vscode-nls';
import { URI, Utils } from 'vscode-uri';
import { LsConfiguration } from '../config';
import { ILogger, LogLevel } from '../logging';
import { IMdParser } from '../parser';
import { MdTableOfContentsProvider } from '../tableOfContents';
import { translatePosition } from '../types/position';
import { makeRange, rangeContains } from '../types/range';
import { getLine, ITextDocument } from '../types/textDocument';
import { coalesce } from '../util/arrays';
import { noopToken } from '../util/cancellation';
import { Disposable } from '../util/dispose';
import { r } from '../util/string';
import { tryDecodeUri } from '../util/uri';
import { getWorkspaceFolder, IWorkspace, tryAppendMarkdownFileExtension } from '../workspace';
import { MdDocumentInfoCache, MdWorkspaceInfoCache } from '../workspaceCache';

const localize = nls.loadMessageBundle();

export enum HrefKind {
	External,
	Internal,
	Reference,
}

export interface ExternalHref {
	readonly kind: HrefKind.External;
	readonly uri: URI;
}

export interface InternalHref {
	readonly kind: HrefKind.Internal;
	readonly path: URI;
	readonly fragment: string;
}

export interface ReferenceHref {
	readonly kind: HrefKind.Reference;
	readonly ref: string;
}

export type LinkHref = ExternalHref | InternalHref | ReferenceHref;

export function resolveInternalDocumentLink(
	sourceDocUri: URI,
	linkText: string,
	workspace: IWorkspace,
): { resource: URI; linkFragment: string } | undefined {
	// Assume it must be an relative or absolute file path
	// Use a fake scheme to avoid parse warnings
	const tempUri = URI.parse(`vscode-resource:${linkText}`);

	const docUri = workspace.getContainingDocument?.(sourceDocUri)?.uri ?? sourceDocUri;

	let resourceUri: URI | undefined;
	if (!tempUri.path) {
		// Looks like a fragment only link
		if (typeof tempUri.fragment !== 'string') {
			return undefined;
		}

		resourceUri = sourceDocUri;
	} else if (tempUri.path[0] === '/') {
		const root = getWorkspaceFolder(workspace, docUri);
		if (root) {
			resourceUri = Utils.joinPath(root, tempUri.path);
		}
	} else {
		if (docUri.scheme === 'untitled') {
			const root = getWorkspaceFolder(workspace, docUri);
			if (root) {
				resourceUri = Utils.joinPath(root, tempUri.path);
			}
		} else {
			const base = Utils.dirname(docUri);
			resourceUri = Utils.joinPath(base, tempUri.path);
		}
	}

	if (!resourceUri) {
		return undefined;
	}

	return {
		resource: resourceUri,
		linkFragment: tempUri.fragment,
	};
}

export interface MdLinkSource {
	/**
	 * The full range of the link.
	 */
	readonly range: lsp.Range;

	/**
	 * The file where the link is defined.
	 */
	readonly resource: URI;

	/**
	 * The range of the entire link target.
	 *
	 * This includes the opening `(`/`[` and closing `)`/`]`.
	 *
	 * For `[boris](/cat.md#siberian "title")` this would be the range of `(/cat.md#siberian "title")`
	 */
	readonly targetRange: lsp.Range;

	/**
	 * The original text of the link destination in code.
	 *
	 * For `[boris](/cat.md#siberian "title")` this would be `/cat.md#siberian`
	 *
	 */
	readonly hrefText: string;

	/**
	 * The original text of just the link's path in code.
	 *
	 * For `[boris](/cat.md#siberian "title")` this would be `/cat.md`
	 */
	readonly pathText: string;

	/**
	 * The range of the path in this link.
	 *
	 * Does not include whitespace or the link title.
	 *
	 * For `[boris](/cat.md#siberian "title")` this would be the range of `/cat.md#siberian`
	 */
	readonly hrefRange: lsp.Range;

	/**
	 * The range of the fragment within the path.
	 *
	 * For `[boris](/cat.md#siberian "title")` this would be the range of `#siberian`
	 *
	 */
	readonly fragmentRange: lsp.Range | undefined;
}

export enum MdLinkKind {
	Link = 1,
	Definition = 2,
}

export interface MdInlineLink<HrefType = LinkHref> {
	readonly kind: MdLinkKind.Link;
	readonly source: MdLinkSource;
	readonly href: HrefType;
}

export interface MdLinkDefinition {
	readonly kind: MdLinkKind.Definition;
	readonly source: MdLinkSource;
	readonly ref: {
		readonly range: lsp.Range;
		readonly text: string;
	};
	readonly href: ExternalHref | InternalHref;
}

export type MdLink = MdInlineLink | MdLinkDefinition;

function createHref(
	sourceDocUri: URI,
	link: string,
	workspace: IWorkspace,
): ExternalHref | InternalHref | undefined {
	if (/^[a-z\-][a-z\-]+:/i.test(link)) {
		// Looks like a uri
		return { kind: HrefKind.External, uri: URI.parse(tryDecodeUri(link)) };
	}

	const resolved = resolveInternalDocumentLink(sourceDocUri, link, workspace);
	if (!resolved) {
		return undefined;
	}

	return {
		kind: HrefKind.Internal,
		path: resolved.resource,
		fragment: resolved.linkFragment,
	};
}

function createMdLink(
	document: ITextDocument,
	targetText: string,
	preHrefText: string,
	rawLink: string,
	matchIndex: number,
	fullMatch: string,
	workspace: IWorkspace,
): MdLink | undefined {
	const isAngleBracketLink = rawLink.startsWith('<');
	const link = stripAngleBrackets(rawLink);

	let linkTarget: ExternalHref | InternalHref | undefined;
	try {
		linkTarget = createHref(URI.parse(document.uri), link, workspace);
	} catch {
		return undefined;
	}
	if (!linkTarget) {
		return undefined;
	}

	const pre = targetText + preHrefText;
	const linkStart = document.positionAt(matchIndex);
	const linkEnd = translatePosition(linkStart, { characterDelta: fullMatch.length });

	const targetStart = translatePosition(linkStart, { characterDelta: targetText.length });
	const targetRange: lsp.Range = { start: targetStart, end: linkEnd };

	const hrefStart = translatePosition(linkStart, { characterDelta: pre.length + (isAngleBracketLink ? 1 : 0) });
	const hrefEnd = translatePosition(hrefStart, { characterDelta: link.length });
	const hrefRange: lsp.Range = { start: hrefStart, end: hrefEnd };

	return {
		kind: MdLinkKind.Link,
		href: linkTarget,
		source: {
			hrefText: link,
			resource: URI.parse(document.uri),
			range: { start: linkStart, end: linkEnd },
			targetRange,
			hrefRange,
			...getLinkSourceFragmentInfo(document, link, hrefStart, hrefEnd),
		}
	};
}

function getFragmentRange(text: string, start: lsp.Position, end: lsp.Position): lsp.Range | undefined {
	const index = text.indexOf('#');
	if (index < 0) {
		return undefined;
	}
	return { start: translatePosition(start, { characterDelta: index + 1 }), end };
}

function getLinkSourceFragmentInfo(document: ITextDocument, link: string, linkStart: lsp.Position, linkEnd: lsp.Position): { fragmentRange: lsp.Range | undefined; pathText: string } {
	const fragmentRange = getFragmentRange(link, linkStart, linkEnd);
	return {
		pathText: document.getText({ start: linkStart, end: fragmentRange ? translatePosition(fragmentRange.start, { characterDelta: -1 }) : linkEnd }),
		fragmentRange,
	};
}

const angleBracketLinkRe = /^<(.*)>$/;

/**
 * Used to strip brackets from the markdown link
 *
 * <http://example.com> will be transformed to http://example.com
*/
function stripAngleBrackets(link: string) {
	return link.replace(angleBracketLinkRe, '$1');
}

/**
 * Matches `[text](link)` or `[text](<link>)`
 */
const linkPattern = new RegExp(
	// text
	r`(\[` + // open prefix match -->
	/**/r`(?:` +
	/*****/r`[^\[\]\\]|` + // Non-bracket chars, or...
	/*****/r`\\.|` + // Escaped char, or...
	/*****/r`\[[^\[\]]*\]` + // Matched bracket pair
	/**/r`)*` +
	r`\])` + // <-- close prefix match

	// Destination
	r`(\(\s*)` + // Pre href
	/**/r`(` +
	/*****/r`[^\s\(\)\<](?:[^\s\(\)]|\([^\s\(\)]*?\))*|` + // Link without whitespace, or...
	/*****/r`<[^<>]+>` + // In angle brackets
	/**/r`)` +

	// Title
	/**/r`\s*(?:"[^"]*"|'[^']*'|\([^\(\)]*\))?\s*` +
	r`\)`,
	'g');

/**
* Matches `[text][ref]` or `[shorthand]`
*/
const referenceLinkPattern = new RegExp(
	r`(^|[^\]\\])` + // Must not start with another bracket (workaround for lack of support for negative look behinds)
	r`(?:` +
	/**/r`(?:` +
	/****/r`(` + // Start link prefix
	/******/r`!?` + // Optional image ref
	/******/r`\[((?:\\\]|[^\]])*)\]` + // Link text
	/******/r`\[\s*?` + // Start of link def
	/****/r`)` + // end link prefix
	/****/r`(` +
	/******/r`[^\]]*?)\]` + //link def
	/******/r`|` +
	/******/r`\[\s*?([^\s\\\]]*?)\])(?![\:\(])` +
	r`)`,
	'gm');

/**
 * Matches `<http://example.com>`
 */
const autoLinkPattern = /\<(\w+:[^\>\s]+)\>/g;

/**
 * Matches `[text]: link`
 */
const definitionPattern = /^([\t ]*\[(?!\^)((?:\\\]|[^\]])+)\]:\s*)([^<]\S*|<[^>]+>)/gm;

const inlineCodePattern = /(?:^|[^`])(`+)(?:.+?|.*?(?:(?:\r?\n).+?)*?)(?:\r?\n)?\1(?:$|[^`])/gm;

class NoLinkRanges {
	public static async compute(tokenizer: IMdParser, document: ITextDocument): Promise<NoLinkRanges> {
		const tokens = await tokenizer.tokenize(document);
		const multiline = tokens.filter(t => (t.type === 'code_block' || t.type === 'fence' || t.type === 'html_block') && !!t.map).map(t => t.map) as [number, number][];

		const inlineRanges = new Map</* line number */ number, lsp.Range[]>();
		const text = document.getText();
		for (const match of text.matchAll(inlineCodePattern)) {
			const startOffset = match.index ?? 0;
			const startPosition = document.positionAt(startOffset);

			const range: lsp.Range = { start: startPosition, end: document.positionAt(startOffset + match[0].length) };
			for (let line = range.start.line; line <= range.end.line; ++line) {
				let entry = inlineRanges.get(line);
				if (!entry) {
					entry = [];
					inlineRanges.set(line, entry);
				}
				entry.push(range);
			}
		}

		return new NoLinkRanges(multiline, inlineRanges);
	}

	private constructor(
		/**
		 * code blocks and fences each represented by [line_start,line_end).
		 */
		public readonly multiline: ReadonlyArray<[number, number]>,

		/**
		 * Inline code spans where links should not be detected
		 */
		public readonly inline: Map</* line number */ number, lsp.Range[]>
	) { }

	contains(position: lsp.Position): boolean {
		return this.multiline.some(interval => position.line >= interval[0] && position.line < interval[1]) ||
			!!this.inline.get(position.line)?.some(inlineRange => rangeContains(inlineRange, position));
	}

	concatInline(inlineRanges: Iterable<lsp.Range>): NoLinkRanges {
		const newInline = new Map(this.inline);
		for (const range of inlineRanges) {
			for (let line = range.start.line; line <= range.end.line; ++line) {
				let entry = newInline.get(line);
				if (!entry) {
					entry = [];
					newInline.set(line, entry);
				}
				entry.push(range);
			}
		}
		return new NoLinkRanges(this.multiline, newInline);
	}
}

export type ResolvedDocumentLinkTarget =
	| { readonly kind: 'file'; readonly uri: URI; position?: lsp.Position; fragment?: string }
	| { readonly kind: 'folder'; readonly uri: URI }
	| { readonly kind: 'external'; readonly uri: URI }

/**
 * Stateless object that extracts link information from markdown files.
 */
export class MdLinkComputer {

	constructor(
		private readonly tokenizer: IMdParser,
		private readonly workspace: IWorkspace,
	) { }

	public async getAllLinks(document: ITextDocument, token: CancellationToken): Promise<MdLink[]> {
		const noLinkRanges = await NoLinkRanges.compute(this.tokenizer, document);
		if (token.isCancellationRequested) {
			return [];
		}

		const inlineLinks = Array.from(this.getInlineLinks(document, noLinkRanges));
		return Array.from([
			...inlineLinks,
			...this.getReferenceLinks(document, noLinkRanges.concatInline(inlineLinks.map(x => x.source.range))),
			...this.getLinkDefinitions(document, noLinkRanges),
			...this.getAutoLinks(document, noLinkRanges),
		]);
	}

	private *getInlineLinks(document: ITextDocument, noLinkRanges: NoLinkRanges): Iterable<MdLink> {
		const text = document.getText();
		for (const match of text.matchAll(linkPattern)) {
			const matchLinkData = createMdLink(document, match[1], match[2], match[3], match.index ?? 0, match[0], this.workspace);
			if (matchLinkData && !noLinkRanges.contains(matchLinkData.source.hrefRange.start)) {
				yield matchLinkData;

				// Also check link destination for links
				for (const innerMatch of match[1].matchAll(linkPattern)) {
					const innerData = createMdLink(document, innerMatch[1], innerMatch[2], innerMatch[3], (match.index ?? 0) + (innerMatch.index ?? 0), innerMatch[0], this.workspace);
					if (innerData) {
						yield innerData;
					}
				}
			}
		}
	}

	private *getAutoLinks(document: ITextDocument, noLinkRanges: NoLinkRanges): Iterable<MdLink> {
		const text = document.getText();
		const docUri = URI.parse(document.uri);
		for (const match of text.matchAll(autoLinkPattern)) {
			const linkOffset = (match.index ?? 0);
			const linkStart = document.positionAt(linkOffset);
			if (noLinkRanges.contains(linkStart)) {
				continue;
			}

			const link = match[1];
			const linkTarget = createHref(docUri, link, this.workspace);
			if (!linkTarget) {
				continue;
			}

			const linkEnd = translatePosition(linkStart, { characterDelta: match[0].length });
			const hrefStart = translatePosition(linkStart, { characterDelta: 1 });
			const hrefEnd = translatePosition(hrefStart, { characterDelta: link.length });
			const hrefRange = { start: hrefStart, end: hrefEnd };
			yield {
				kind: MdLinkKind.Link,
				href: linkTarget,
				source: {
					hrefText: link,
					resource: docUri,
					targetRange: hrefRange,
					hrefRange: hrefRange,
					range: { start: linkStart, end: linkEnd },
					...getLinkSourceFragmentInfo(document, link, hrefStart, hrefEnd),
				}
			};
		}
	}

	private *getReferenceLinks(document: ITextDocument, noLinkRanges: NoLinkRanges): Iterable<MdLink> {
		const text = document.getText();
		for (const match of text.matchAll(referenceLinkPattern)) {
			const linkStartOffset = (match.index ?? 0) + match[1].length;
			const linkStart = document.positionAt(linkStartOffset);
			if (noLinkRanges.contains(linkStart)) {
				continue;
			}

			let hrefStart: lsp.Position;
			let hrefEnd: lsp.Position;
			let reference = match[4];
			if (reference === '') { // [ref][],
				reference = match[3];
				if (!reference) {
					continue;
				}
				const offset = linkStartOffset + 1;
				hrefStart = document.positionAt(offset);
				hrefEnd = document.positionAt(offset + reference.length);
			} else if (reference) { // [text][ref]
				const text = match[3];
				if (!text) {
					// Handle the case ![][cat]
					if (match[0].startsWith('!')) {
						//
					} else {
						continue;
					}
				}

				const pre = match[2];
				const offset = linkStartOffset + pre.length;
				hrefStart = document.positionAt(offset);
				hrefEnd = document.positionAt(offset + reference.length);
			} else if (match[5]) { // [ref]
				reference = match[5];
				const offset = linkStartOffset + 1;
				hrefStart = document.positionAt(offset);
				const line = getLine(document, hrefStart.line);
				// See if link looks like a checkbox
				const checkboxMatch = line.match(/^\s*[\-\*]\s*\[x\]/i);
				if (checkboxMatch && hrefStart.character <= checkboxMatch[0].length) {
					continue;
				}
				hrefEnd = document.positionAt(offset + reference.length);
			} else {
				continue;
			}

			const linkEnd = translatePosition(linkStart, { characterDelta: match[0].length - match[1].length });
			const hrefRange = { start: hrefStart, end: hrefEnd };
			yield {
				kind: MdLinkKind.Link,
				source: {
					hrefText: reference,
					pathText: reference,
					resource: URI.parse(document.uri),
					range: { start: linkStart, end: linkEnd },
					targetRange: hrefRange,
					hrefRange: hrefRange,
					fragmentRange: undefined,
				},
				href: {
					kind: HrefKind.Reference,
					ref: reference,
				}
			};
		}
	}

	private *getLinkDefinitions(document: ITextDocument, noLinkRanges: NoLinkRanges): Iterable<MdLinkDefinition> {
		const text = document.getText();
		const docUri = URI.parse(document.uri);
		for (const match of text.matchAll(definitionPattern)) {
			const offset = (match.index ?? 0);
			const linkStart = document.positionAt(offset);
			if (noLinkRanges.contains(linkStart)) {
				continue;
			}

			const pre = match[1];
			const reference = match[2];
			const rawLinkText = match[3].trim();
			const isAngleBracketLink = angleBracketLinkRe.test(rawLinkText);
			const linkText = stripAngleBrackets(rawLinkText);

			const target = createHref(docUri, linkText, this.workspace);
			if (!target) {
				continue;
			}

			const hrefStart = translatePosition(linkStart, { characterDelta: pre.length + (isAngleBracketLink ? 1 : 0) });
			const hrefEnd = translatePosition(hrefStart, { characterDelta: linkText.length });
			const hrefRange = { start: hrefStart, end: hrefEnd };

			const refStart = translatePosition(linkStart, { characterDelta: 1 });
			const refRange: lsp.Range = { start: refStart, end: translatePosition(refStart, { characterDelta: reference.length }) };
			const linkEnd = translatePosition(linkStart, { characterDelta: match[0].length });
			yield {
				kind: MdLinkKind.Definition,
				source: {
					hrefText: linkText,
					resource: docUri,
					range: { start: linkStart, end: linkEnd },
					targetRange: hrefRange,
					hrefRange,
					...getLinkSourceFragmentInfo(document, rawLinkText, hrefStart, hrefEnd),
				},
				ref: { text: reference, range: refRange },
				href: target,
			};
		}
	}
}

export interface MdDocumentLinksInfo {
	readonly links: readonly MdLink[];
	readonly definitions: LinkDefinitionSet;
}

export class LinkDefinitionSet implements Iterable<[string, MdLinkDefinition]> {
	private readonly _map = new Map<string, MdLinkDefinition>();

	constructor(links: Iterable<MdLink>) {
		for (const link of links) {
			if (link.kind === MdLinkKind.Definition) {
				this._map.set(link.ref.text, link);
			}
		}
	}

	public [Symbol.iterator](): Iterator<[string, MdLinkDefinition]> {
		return this._map.entries();
	}

	public lookup(ref: string): MdLinkDefinition | undefined {
		return this._map.get(ref);
	}
}

/**
 * Stateful object which provides links for markdown files the workspace.
 */
export class MdLinkProvider extends Disposable {

	private readonly _linkCache: MdDocumentInfoCache<MdDocumentLinksInfo>;

	private readonly _linkComputer: MdLinkComputer;

	constructor(
		private readonly _config: LsConfiguration,
		tokenizer: IMdParser,
		private readonly _workspace: IWorkspace,
		private readonly _tocProvider: MdTableOfContentsProvider,
		logger: ILogger,
	) {
		super();
		this._linkComputer = new MdLinkComputer(tokenizer, _workspace);
		this._linkCache = this._register(new MdDocumentInfoCache(this._workspace, async doc => {
			logger.log(LogLevel.Debug, 'LinkProvider', `compute - ${doc.uri}`);

			const links = await this._linkComputer.getAllLinks(doc, noopToken);
			return {
				links,
				definitions: new LinkDefinitionSet(links),
			};
		}));
	}

	public getLinks(document: ITextDocument): Promise<MdDocumentLinksInfo> {
		return this._linkCache.getForDocument(document);
	}

	public async provideDocumentLinks(document: ITextDocument, token: CancellationToken): Promise<lsp.DocumentLink[]> {
		const { links, definitions } = await this.getLinks(document);
		if (token.isCancellationRequested) {
			return [];
		}

		return coalesce(links.map(data => this.toValidDocumentLink(data, definitions)));
	}

	public async resolveDocumentLink(link: lsp.DocumentLink, token: CancellationToken): Promise<lsp.DocumentLink | undefined> {
		const href = this.reviveLinkHrefData(link);
		if (!href) {
			return undefined;
		}

		const target = await this.resolveInternalLinkTarget(href.path, href.fragment, token);
		switch (target.kind) {
			case 'folder':
				link.target = this.createCommandUri('revealInExplorer', href);
				break;
			case 'external':
				link.target = target.uri.toString(true);
				break;
			case 'file':
				if (target.position) {
					link.target = this.createOpenAtPosCommand(target.uri, target.position);
				} else {
					link.target = target.uri.toString(true);
				}
				break;
		}

		return link;
	}

	public async resolveLinkTarget(linkText: string, sourceDoc: URI, token: CancellationToken): Promise<ResolvedDocumentLinkTarget | undefined> {
		const href = createHref(sourceDoc, linkText, this._workspace);
		if (href?.kind !== HrefKind.Internal) {
			return undefined;
		}

		const resolved = resolveInternalDocumentLink(sourceDoc, linkText, this._workspace);
		if (!resolved) {
			return undefined;
		}

		return this.resolveInternalLinkTarget(resolved.resource, resolved.linkFragment, token);
	}

	private async resolveInternalLinkTarget(linkPath: URI, linkFragment: string, token: CancellationToken): Promise<ResolvedDocumentLinkTarget> {
		let target = linkPath;

		// If there's a containing document, don't bother with trying to resolve the
		// link to a workspace file as one will not exist
		const containingContext = this._workspace.getContainingDocument?.(target);
		if (!containingContext) {
			const stat = await this._workspace.stat(target);
			if (stat?.isDirectory) {
				return { kind: 'folder', uri: target };
			}

			if (token.isCancellationRequested) {
				return { kind: 'folder', uri: target };
			}

			if (!stat) {
				// We don't think the file exists. If it doesn't already have an extension, try tacking on a `.md` and using that instead
				let found = false;
				const dotMdResource = tryAppendMarkdownFileExtension(this._config, target);
				if (dotMdResource) {
					if (await this._workspace.stat(dotMdResource)) {
						target = dotMdResource;
						found = true;
					}
				}

				if (!found) {
					return { kind: 'file', uri: target };
				}
			}
		}

		if (!linkFragment) {
			return { kind: 'file', uri: target };
		}

		// Try navigating with fragment that sets line number
		const locationLinkPosition = parseLocationInfoFromFragment(linkFragment);
		if (locationLinkPosition) {
			return { kind: 'file', uri: target, position: locationLinkPosition };
		}

		// Try navigating to header in file
		const doc = await this._workspace.openMarkdownDocument(target);
		if (doc) {
			const toc = await this._tocProvider.getForContainingDoc(doc);
			const entry = toc.lookup(linkFragment);
			if (entry) {
				return { kind: 'file', uri: URI.parse(entry.headerLocation.uri), position: entry.headerLocation.range.start, fragment: linkFragment };
			}
		}

		return { kind: 'file', uri: target };
	}

	private reviveLinkHrefData(link: lsp.DocumentLink): { path: URI, fragment: string } | undefined {
		if (!link.data) {
			return undefined;
		}

		const mdLink = link.data as MdLink;
		if (mdLink.href.kind !== HrefKind.Internal) {
			return undefined;
		}

		return { path: URI.from(mdLink.href.path), fragment: mdLink.href.fragment };
	}

	private toValidDocumentLink(link: MdLink, definitionSet: LinkDefinitionSet): lsp.DocumentLink | undefined {
		switch (link.href.kind) {
			case HrefKind.External: {
				return {
					range: link.source.hrefRange,
					target: link.href.uri.toString(true),
				};
			}
			case HrefKind.Internal: {
				return {
					range: link.source.hrefRange,
					target: undefined, // Needs to be resolved later
					tooltip: localize('tooltip.link', 'Follow link'),
					data: link,
				};
			}
			case HrefKind.Reference: {
				// We only render reference links in the editor if they are actually defined.
				// This matches how reference links are rendered by markdown-it.
				const def = definitionSet.lookup(link.href.ref);
				if (!def) {
					return undefined;
				}

				const target = this.createOpenAtPosCommand(link.source.resource, def.source.hrefRange.start);
				return {
					range: link.source.hrefRange,
					tooltip: localize('tooltip.definition', 'Go to link definition'),
					target: target,
					data: link
				};
			}
		}
	}

	private createCommandUri(command: string, ...args: any[]): string {
		return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
	}

	private createOpenAtPosCommand(resource: URI, pos: lsp.Position): string {
		// If the resource itself already has a fragment, we need to handle opening specially 
		// instead of using `file://path.md#L123` style uris
		if (resource.fragment) {
			// Match the args of `vscode.open`
			return this.createCommandUri('vscodeMarkdownLanguageservice.open', resource, {
				selection: makeRange(pos, pos),
			});
		}

		return resource.with({
			fragment: `L${pos.line + 1},${pos.character + 1}`
		}).toString(true);
	}
}

/**
 * Extract position info from link fragments that look like `#L5,3`
 */
export function parseLocationInfoFromFragment(fragment: string): lsp.Position | undefined {
	const match = fragment.match(/^L(\d+)(?:,(\d+))?$/i);
	if (!match) {
		return undefined;
	}

	const line = +match[1] - 1;
	if (isNaN(line)) {
		return undefined;
	}

	const column = +match[2] - 1;
	return { line, character: isNaN(column) ? 0 : column };
}

export function createWorkspaceLinkCache(
	parser: IMdParser,
	workspace: IWorkspace,
) {
	const linkComputer = new MdLinkComputer(parser, workspace);
	return new MdWorkspaceInfoCache(workspace, doc => linkComputer.getAllLinks(doc, noopToken));
}