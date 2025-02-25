/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as lsp from 'vscode-languageserver-types';
import { URI } from 'vscode-uri';
import { ILogger, LogLevel } from './logging';
import { IMdParser, Token } from './parser';
import { githubSlugifier, ISlugifier, Slug } from './slugify';
import { makeRange } from './types/range';
import { getLine, ITextDocument } from './types/textDocument';
import { Disposable } from './util/dispose';
import { IWorkspace } from './workspace';
import { MdDocumentInfoCache } from './workspaceCache';

export interface TocEntry {
	readonly slug: Slug;
	readonly text: string;
	readonly level: number;
	readonly line: number;

	/**
	 * The entire range of the header section.
	 *
	* For the doc:
	 *
	 * ```md
	 * # Head #
	 * text
	 * # Next head #
	 * ```
	 *
	 * This is the range from `# Head #` to `# Next head #`
	 */
	readonly sectionLocation: lsp.Location;

	/**
	 * The range of the header declaration.
	 *
	 * For the doc:
	 *
	 * ```md
	 * # Head #
	 * text
	 * ```
	 *
	 * This is the range of `# Head #`
	 */
	readonly headerLocation: lsp.Location;

	/**
	 * The range of the header text.
	 *
	 * For the doc:
	 *
	 * ```md
	 * # Head #
	 * text
	 * ```
	 *
	 * This is the range of `Head`
	 */
	readonly headerTextLocation: lsp.Location;
}

export class TableOfContents {

	public static async create(parser: IMdParser, document: ITextDocument,): Promise<TableOfContents> {
		const entries = await this.buildToc(parser, document);
		return new TableOfContents(entries, parser.slugifier);
	}

	public static async createForContainingDoc(parser: IMdParser, workspace: IWorkspace, document: ITextDocument): Promise<TableOfContents> {
		const context = workspace.getContainingDocument?.(URI.parse(document.uri));
		if (context) {
			const entries: TocEntry[] = [];
			await Promise.all(Array.from(context.children, async cell => {
				const doc = await workspace.openMarkdownDocument(cell.uri);
				if (doc) {
					entries.push(...(await this.buildToc(parser, doc)));
				}
			}));
			return new TableOfContents(entries, parser.slugifier);
		}

		return this.create(parser, document);
	}

	private static async buildToc(parser: IMdParser, document: ITextDocument): Promise<TocEntry[]> {
		const docUri = URI.parse(document.uri);

		const toc: TocEntry[] = [];
		const tokens = await parser.tokenize(document);

		const existingSlugEntries = new Map<string, { count: number }>();

		type HeaderInfo = { open: Token; body: Token[] };

		const headers: HeaderInfo[] = [];
		let currentHeader: HeaderInfo | undefined;

		for (const token of tokens) {
			switch (token.type) {
				case 'heading_open': {
					currentHeader = { open: token, body: [] };
					headers.push(currentHeader);
					break;
				}
				case 'heading_close': {
					currentHeader = undefined;
					break;
				}
				default: {
					currentHeader?.body.push(token);
					break;
				}
			}
		}

		for (const { open, body } of headers) {
			if (!open.map) {
				continue;
			}

			const lineNumber = open.map[0];
			const line = getLine(document, lineNumber);
			const bodyText = TableOfContents.getHeaderTitleAsPlainText(body);

			let slug = parser.slugifier.fromHeading(bodyText);
			const existingSlugEntry = existingSlugEntries.get(slug.value);
			if (existingSlugEntry) {
				++existingSlugEntry.count;
				slug = parser.slugifier.fromHeading(slug.value + '-' + existingSlugEntry.count);
			} else {
				existingSlugEntries.set(slug.value, { count: 0 });
			}

			const headerLocation: lsp.Location = {
				uri: docUri.toString(),
				range: makeRange(lineNumber, 0, lineNumber, line.length)
			};

			const headerTextLocation: lsp.Location = {
				uri: docUri.toString(),
				range: makeRange(lineNumber, line.match(/^#+\s*/)?.[0].length ?? 0, lineNumber, line.length - (line.match(/\s*#*$/)?.[0].length ?? 0))
			};

			toc.push({
				slug,
				text: line.replace(/^\s*#+\s*(.*?)(\s+#+)?$/, (_, word) => word.trim()),
				level: TableOfContents.getHeaderLevel(open.markup),
				line: lineNumber,
				sectionLocation: headerLocation, // Populated in next steps
				headerLocation,
				headerTextLocation
			});
		}

		// Get full range of section
		return toc.map((entry, startIndex): TocEntry => {
			let end: number | undefined = undefined;
			for (let i = startIndex + 1; i < toc.length; ++i) {
				if (toc[i].level <= entry.level) {
					end = toc[i].line - 1;
					break;
				}
			}
			const endLine = end ?? document.lineCount - 1;
			return {
				...entry,
				sectionLocation: {
					uri: docUri.toString(),
					range: makeRange(
						entry.sectionLocation.range.start,
						{ line: endLine, character: getLine(document, endLine).length })
				}
			};
		});
	}

	private static getHeaderLevel(markup: string): number {
		if (markup === '=') {
			return 1;
		} else if (markup === '-') {
			return 2;
		} else { // '#', '##', ...
			return markup.length;
		}
	}

	private static tokenToPlainText(token: Token): string {
		if (token.children) {
			return token.children.map(TableOfContents.tokenToPlainText).join('');
		}

		switch (token.type) {
			case 'text':
			case 'emoji':
			case 'code_inline':
				return token.content;
			default:
				return '';
		}
	}

	private static getHeaderTitleAsPlainText(headerTitleParts: readonly Token[]): string {
		return headerTitleParts
			.map(TableOfContents.tokenToPlainText)
			.join('')
			.trim();
	}

	public static readonly empty = new TableOfContents([], githubSlugifier);

	private constructor(
		public readonly entries: readonly TocEntry[],
		private readonly slugifier: ISlugifier,
	) { }

	public lookup(fragment: string): TocEntry | undefined {
		const slug = this.slugifier.fromHeading(fragment);
		return this.entries.find(entry => entry.slug.equals(slug));
	}
}


export class MdTableOfContentsProvider extends Disposable {

	private readonly _cache: MdDocumentInfoCache<TableOfContents>;

	constructor(
		private readonly parser: IMdParser,
		private readonly workspace: IWorkspace,
		private readonly logger: ILogger,
	) {
		super();
		this._cache = this._register(new MdDocumentInfoCache<TableOfContents>(workspace, doc => {
			this.logger.log(LogLevel.Debug, 'TableOfContentsProvider', `create - ${doc.uri}`);
			return TableOfContents.create(parser, doc);
		}));
	}

	public async get(resource: URI): Promise<TableOfContents> {
		return await this._cache.get(resource) ?? TableOfContents.empty;
	}

	public getForDocument(doc: ITextDocument): Promise<TableOfContents> {
		return this._cache.getForDocument(doc);
	}

	public getForContainingDoc(doc: ITextDocument): Promise<TableOfContents> {
		return TableOfContents.createForContainingDoc(this.parser, this.workspace, doc);
	}
}
