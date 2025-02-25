/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from 'vscode-uri';
import { ITextDocument } from './types/textDocument';
import { Disposable } from './util/dispose';
import { lazy, Lazy } from './util/lazy';
import { ResourceMap } from './util/resourceMap';
import { IWorkspace } from './workspace';


class LazyResourceMap<T> {
	private readonly _map = new ResourceMap<Lazy<Promise<T>>>();

	public has(resource: URI): boolean {
		return this._map.has(resource);
	}

	public get(resource: URI): Promise<T> | undefined {
		return this._map.get(resource)?.value;
	}

	public set(resource: URI, value: Lazy<Promise<T>>) {
		this._map.set(resource, value);
	}

	public delete(resource: URI) {
		this._map.delete(resource);
	}

	public entries(): Promise<Array<[URI, T]>> {
		return Promise.all(Array.from(this._map.entries(), async ([key, entry]) => {
			return [key, await entry.value];
		}));
	}
}

/**
 * Cache of information per-document in the workspace.
 *
 * The values are computed lazily and invalidated when the document changes.
 */
export class MdDocumentInfoCache<T> extends Disposable {

	private readonly _cache = new LazyResourceMap<T>();
	private readonly _loadingDocuments = new ResourceMap<Promise<ITextDocument | undefined>>();

	public constructor(
		private readonly workspace: IWorkspace,
		private readonly getValue: (document: ITextDocument) => Promise<T>,
	) {
		super();

		this._register(this.workspace.onDidChangeMarkdownDocument(doc => this.invalidate(doc)));
		this._register(this.workspace.onDidDeleteMarkdownDocument(this.onDidDeleteDocument, this));
	}

	public async get(resource: URI): Promise<T | undefined> {
		let existing = this._cache.get(resource);
		if (existing) {
			return existing;
		}

		const doc = await this.loadDocument(resource);
		if (!doc) {
			return undefined;
		}

		// Check if we have invalidated
		existing = this._cache.get(resource);
		if (existing) {
			return existing;
		}

		return this.resetEntry(doc)?.value;
	}

	public async getForDocument(document: ITextDocument): Promise<T> {
		const existing = this._cache.get(URI.parse(document.uri));
		if (existing) {
			return existing;
		}
		return this.resetEntry(document).value;
	}

	private loadDocument(resource: URI): Promise<ITextDocument | undefined> {
		const existing = this._loadingDocuments.get(resource);
		if (existing) {
			return existing;
		}

		const p = this.workspace.openMarkdownDocument(resource);
		this._loadingDocuments.set(resource, p);
		p.finally(() => {
			this._loadingDocuments.delete(resource);
		});
		return p;
	}

	private resetEntry(document: ITextDocument): Lazy<Promise<T>> {
		const value = lazy(() => this.getValue(document));
		this._cache.set(URI.parse(document.uri), value);
		return value;
	}

	private invalidate(document: ITextDocument): void {
		if (this._cache.has(URI.parse(document.uri))) {
			this.resetEntry(document);
		}
	}

	private onDidDeleteDocument(resource: URI) {
		this._cache.delete(resource);
	}
}

/**
 * Cache of information across all markdown files in the workspace.
 *
 * Unlike {@link MdDocumentInfoCache}, the entries here are computed eagerly for every file in the workspace.
 * However the computation of the values is still lazy.
 */
export class MdWorkspaceInfoCache<T> extends Disposable {

	private readonly _cache = new LazyResourceMap<T>();
	private _init?: Promise<void>;

	public constructor(
		private readonly workspace: IWorkspace,
		private readonly getValue: (document: ITextDocument) => Promise<T>,
	) {
		super();

		this._register(this.workspace.onDidChangeMarkdownDocument(this.onDidChangeDocument, this));
		this._register(this.workspace.onDidCreateMarkdownDocument(this.onDidChangeDocument, this));
		this._register(this.workspace.onDidDeleteMarkdownDocument(this.onDidDeleteDocument, this));
	}

	public async entries(): Promise<Array<[URI, T]>> {
		await this.ensureInit();
		return this._cache.entries();
	}

	public async values(): Promise<Array<T>> {
		await this.ensureInit();
		return Array.from(await this._cache.entries(), x => x[1]);
	}

	public async getForDocs(docs: readonly ITextDocument[]): Promise<T[]> {
		for (const doc of docs) {
			if (!this._cache.has(URI.parse(doc.uri))) {
				this.update(doc);
			}
		}

		return Promise.all(docs.map(doc => this._cache.get(URI.parse(doc.uri)) as Promise<T>));
	}

	private async ensureInit(): Promise<void> {
		if (!this._init) {
			this._init = this.populateCache();
		}
		await this._init;
	}

	private async populateCache(): Promise<void> {
		const markdownDocuments = await this.workspace.getAllMarkdownDocuments();
		for (const document of markdownDocuments) {
			if (!this._cache.has(URI.parse(document.uri))) {
				this.update(document);
			}
		}
	}

	private update(document: ITextDocument): void {
		this._cache.set(URI.parse(document.uri), lazy(() => this.getValue(document)));
	}

	private onDidChangeDocument(document: ITextDocument) {
		this.update(document);
	}

	private onDidDeleteDocument(resource: URI) {
		this._cache.delete(resource);
	}
}
