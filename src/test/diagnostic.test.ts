/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as lsp from 'vscode-languageserver-types';
import { getLsConfiguration } from '../config';
import { DiagnosticComputer, DiagnosticLevel, DiagnosticOptions, DiagnosticsManager, MdDiagnostic } from '../languageFeatures/diagnostics';
import { MdLinkProvider } from '../languageFeatures/documentLinks';
import { MdTableOfContentsProvider } from '../tableOfContents';
import { comparePosition } from '../types/position';
import { makeRange } from '../types/range';
import { noopToken } from '../util/cancellation';
import { DisposableStore } from '../util/dispose';
import { ResourceMap } from '../util/resourceMap';
import { IWorkspace } from '../workspace';
import { createNewMarkdownEngine } from './engine';
import { InMemoryDocument } from './inMemoryDocument';
import { InMemoryWorkspace } from './inMemoryWorkspace';
import { nulLogger } from './nulLogging';
import { assertRangeEqual, joinLines, withStore, workspacePath } from './util';

const defaultDiagnosticsOptions = Object.freeze<DiagnosticOptions>({
	validateFileLinks: DiagnosticLevel.warning,
	validateMarkdownFileLinkFragments: undefined,
	validateFragmentLinks: DiagnosticLevel.warning,
	validateReferences: DiagnosticLevel.warning,
	ignoreLinks: [],
});

async function getComputedDiagnostics(store: DisposableStore, doc: InMemoryDocument, workspace: IWorkspace, options: Partial<DiagnosticOptions> = {}): Promise<MdDiagnostic[]> {
	const engine = createNewMarkdownEngine();
	const tocProvider = store.add(new MdTableOfContentsProvider(engine, workspace, nulLogger));
	const linkProvider = store.add(new MdLinkProvider(engine, workspace, tocProvider, nulLogger));
	const computer = new DiagnosticComputer(getLsConfiguration({}), workspace, linkProvider, tocProvider);
	return (
		await computer.compute(doc, getDiagnosticsOptions(options), new ResourceMap(), noopToken)
	).diagnostics;
}

function getDiagnosticsOptions(options: Partial<DiagnosticOptions>): DiagnosticOptions {
	return { ...defaultDiagnosticsOptions, ...options, };
}

function assertDiagnosticsEqual(actual: readonly MdDiagnostic[], expectedRanges: readonly lsp.Range[]) {
	assert.strictEqual(actual.length, expectedRanges.length, "Diagnostic count equal");

	for (let i = 0; i < actual.length; ++i) {
		assertRangeEqual(actual[i].range, expectedRanges[i], `Range ${i} to be equal`);
	}
}

function orderDiagnosticsByRange(diagnostics: Iterable<MdDiagnostic>): readonly MdDiagnostic[] {
	return Array.from(diagnostics).sort((a, b) => comparePosition(a.range.start, b.range.start));
}


suite('Diagnostic Computer', () => {

	test('Should not return any diagnostics for empty document', withStore(async (store) => {
		const doc = new InMemoryDocument(workspacePath('doc.md'), joinLines(
			`text`,
		));
		const workspace = store.add(new InMemoryWorkspace([doc]));

		const diagnostics = await getComputedDiagnostics(store, doc, workspace);
		assert.deepStrictEqual(diagnostics, []);
	}));

	test('Should generate diagnostic for link to file that does not exist', withStore(async (store) => {
		const doc = new InMemoryDocument(workspacePath('doc.md'), joinLines(
			`[bad](/no/such/file.md)`,
			`[good](/doc.md)`,
			`[good-ref]: /doc.md`,
			`[bad-ref]: /no/such/file.md`,
		));
		const workspace = store.add(new InMemoryWorkspace([doc]));

		const diagnostics = await getComputedDiagnostics(store, doc, workspace);
		assertDiagnosticsEqual(diagnostics, [
			makeRange(0, 6, 0, 22),
			makeRange(3, 11, 3, 27),
		]);
	}));

	test('Should generate diagnostics for links to header that does not exist in current file', withStore(async (store) => {
		const doc = new InMemoryDocument(workspacePath('doc.md'), joinLines(
			`[good](#good-header)`,
			`# Good Header`,
			`[bad](#no-such-header)`,
			`[good](#good-header)`,
			`[good-ref]: #good-header`,
			`[bad-ref]: #no-such-header`,
		));
		const workspace = store.add(new InMemoryWorkspace([doc]));

		const diagnostics = await getComputedDiagnostics(store, doc, workspace);
		assertDiagnosticsEqual(diagnostics, [
			makeRange(2, 6, 2, 21),
			makeRange(5, 11, 5, 26),
		]);
	}));

	test('Should generate diagnostics for links to non-existent headers in other files', withStore(async (store) => {
		const doc1 = new InMemoryDocument(workspacePath('doc1.md'), joinLines(
			`# My header`,
			`[good](#my-header)`,
			`[good](/doc1.md#my-header)`,
			`[good](doc1.md#my-header)`,
			`[good](/doc2.md#other-header)`,
			`[bad](/doc2.md#no-such-other-header)`,
		));

		const doc2 = new InMemoryDocument(workspacePath('doc2.md'), joinLines(
			`# Other header`,
		));

		const diagnostics = await getComputedDiagnostics(store, doc1, new InMemoryWorkspace([doc1, doc2]));
		assertDiagnosticsEqual(diagnostics, [
			makeRange(5, 14, 5, 35),
		]);
	}));

	test('Should support links both with and without .md file extension', withStore(async (store) => {
		const doc = new InMemoryDocument(workspacePath('doc.md'), joinLines(
			`# My header`,
			`[good](#my-header)`,
			`[good](/doc.md#my-header)`,
			`[good](doc.md#my-header)`,
			`[good](/doc#my-header)`,
			`[good](doc#my-header)`,
		));
		const workspace = store.add(new InMemoryWorkspace([doc]));

		const diagnostics = await getComputedDiagnostics(store, doc, workspace);
		assertDiagnosticsEqual(diagnostics, []);
	}));

	test('Should generate diagnostics for non-existent link reference', withStore(async (store) => {
		const doc = new InMemoryDocument(workspacePath('doc.md'), joinLines(
			`[good link][good]`,
			`[bad link][no-such]`,
			``,
			`[good]: http://example.com`,
		));
		const workspace = store.add(new InMemoryWorkspace([doc]));

		const diagnostics = await getComputedDiagnostics(store, doc, workspace);
		assertDiagnosticsEqual(diagnostics, [
			makeRange(1, 11, 1, 18),
		]);
	}));

	// test('Should not generate diagnostics when validate is disabled', withStore(async (store) => {
	// 	const doc1 = new InMemoryDocument(workspacePath('doc1.md'), joinLines(
	// 		`[text](#no-such-header)`,
	// 		`[text][no-such-ref]`,
	// 	));
	// 	const workspace = store.add(new InMemoryWorkspace([doc1]));
	// 	const diagnostics = await getComputedDiagnostics(store, doc1, workspace, new MemoryDiagnosticConfiguration({ enabled: false }).getOptions(doc1.uri));
	// 	assertDiagnosticsEqual(diagnostics, []);
	// }));

	test('Should not generate diagnostics for email autolink', withStore(async (store) => {
		const doc1 = new InMemoryDocument(workspacePath('doc1.md'), joinLines(
			`a <user@example.com> c`,
		));

		const diagnostics = await getComputedDiagnostics(store, doc1, new InMemoryWorkspace([doc1]));
		assertDiagnosticsEqual(diagnostics, []);
	}));

	test('Should not generate diagnostics for html tag that looks like an autolink', withStore(async (store) => {
		const doc1 = new InMemoryDocument(workspacePath('doc1.md'), joinLines(
			`a <tag>b</tag> c`,
			`a <scope:tag>b</scope:tag> c`,
		));

		const diagnostics = await getComputedDiagnostics(store, doc1, new InMemoryWorkspace([doc1]));
		assertDiagnosticsEqual(diagnostics, []);
	}));

	test('Should allow ignoring invalid file link using glob', withStore(async (store) => {
		const doc1 = new InMemoryDocument(workspacePath('doc1.md'), joinLines(
			`[text](/no-such-file)`,
			`![img](/no-such-file)`,
			`[text]: /no-such-file`,
		));
		const workspace = store.add(new InMemoryWorkspace([doc1]));
		const diagnostics = await getComputedDiagnostics(store, doc1, workspace, { ignoreLinks: ['/no-such-file'] });
		assertDiagnosticsEqual(diagnostics, []);
	}));

	test('Should be able to disable fragment validation for external files', withStore(async (store) => {
		const doc1 = new InMemoryDocument(workspacePath('doc1.md'), joinLines(
			`![i](/doc2.md#no-such)`,
		));
		const doc2 = new InMemoryDocument(workspacePath('doc2.md'), joinLines(''));
		const workspace = new InMemoryWorkspace([doc1, doc2]);

		const diagnostics = await getComputedDiagnostics(store, doc1, workspace, { validateMarkdownFileLinkFragments: DiagnosticLevel.ignore });
		assertDiagnosticsEqual(diagnostics, []);
	}));

	test('Disabling own fragment validation should also disable path fragment validation by default', withStore(async (store) => {
		const doc1 = new InMemoryDocument(workspacePath('doc1.md'), joinLines(
			`[b](#no-head)`,
			`![i](/doc2.md#no-such)`,
		));
		const doc2 = new InMemoryDocument(workspacePath('doc2.md'), joinLines(''));
		const workspace = new InMemoryWorkspace([doc1, doc2]);

		{
			const diagnostics = await getComputedDiagnostics(store, doc1, workspace, { validateFragmentLinks: DiagnosticLevel.ignore });
			assertDiagnosticsEqual(diagnostics, []);
		}
		{
			// But we should be able to override the default
			const diagnostics = await getComputedDiagnostics(store, doc1, workspace, { validateFragmentLinks: DiagnosticLevel.ignore, validateMarkdownFileLinkFragments: DiagnosticLevel.warning });
			assertDiagnosticsEqual(diagnostics, [
				makeRange(1, 13, 1, 21),
			]);
		}
	}));

	test('ignoreLinks should allow skipping link to non-existent file', withStore(async (store) => {
		const doc1 = new InMemoryDocument(workspacePath('doc1.md'), joinLines(
			`[text](/no-such-file#header)`,
		));
		const workspace = store.add(new InMemoryWorkspace([doc1]));

		const diagnostics = await getComputedDiagnostics(store, doc1, workspace, { ignoreLinks: ['/no-such-file'] });
		assertDiagnosticsEqual(diagnostics, []);
	}));

	test('ignoreLinks should not consider link fragment', withStore(async (store) => {
		const doc1 = new InMemoryDocument(workspacePath('doc1.md'), joinLines(
			`[text](/no-such-file#header)`,
		));
		const workspace = store.add(new InMemoryWorkspace([doc1]));

		const diagnostics = await getComputedDiagnostics(store, doc1, workspace, { ignoreLinks: ['/no-such-file'] });
		assertDiagnosticsEqual(diagnostics, []);
	}));

	test('ignoreLinks should support globs', withStore(async (store) => {
		const doc1 = new InMemoryDocument(workspacePath('doc1.md'), joinLines(
			`![i](/images/aaa.png)`,
			`![i](/images/sub/bbb.png)`,
			`![i](/images/sub/sub2/ccc.png)`,
		));
		const workspace = store.add(new InMemoryWorkspace([doc1]));

		const diagnostics = await getComputedDiagnostics(store, doc1, workspace, { ignoreLinks: ['/images/**/*.png'] });
		assertDiagnosticsEqual(diagnostics, []);
	}));

	test('ignoreLinks should support ignoring header', withStore(async (store) => {
		const doc1 = new InMemoryDocument(workspacePath('doc1.md'), joinLines(
			`![i](#no-such)`,
		));
		const workspace = store.add(new InMemoryWorkspace([doc1]));

		const diagnostics = await getComputedDiagnostics(store, doc1, workspace, { ignoreLinks: ['#no-such'] });
		assertDiagnosticsEqual(diagnostics, []);
	}));

	test('ignoreLinks should support ignoring header in file', withStore(async (store) => {
		const doc1 = new InMemoryDocument(workspacePath('doc1.md'), joinLines(
			`![i](/doc2.md#no-such)`,
		));
		const doc2 = new InMemoryDocument(workspacePath('doc2.md'), joinLines(''));
		const workspace = store.add(new InMemoryWorkspace([doc1, doc2]));

		{
			const diagnostics = await getComputedDiagnostics(store, doc1, workspace, { ignoreLinks: ['/doc2.md#no-such'] });
			assertDiagnosticsEqual(diagnostics, []);
		}
		{
			const diagnostics = await getComputedDiagnostics(store, doc1, workspace, { ignoreLinks: ['/doc2.md#*'] });
			assertDiagnosticsEqual(diagnostics, []);
		}
	}));

	test('ignoreLinks should support ignore header links if file is ignored', withStore(async (store) => {
		const doc1 = new InMemoryDocument(workspacePath('doc1.md'), joinLines(
			`![i](/doc2.md#no-such)`,
		));
		const doc2 = new InMemoryDocument(workspacePath('doc2.md'), joinLines(''));
		const workspace = new InMemoryWorkspace([doc1, doc2]);

		const diagnostics = await getComputedDiagnostics(store, doc1, workspace, { ignoreLinks: ['/doc2.md'] });
		assertDiagnosticsEqual(diagnostics, []);
	}));

	test('Should not detect checkboxes as invalid links', withStore(async (store) => {
		const doc1 = new InMemoryDocument(workspacePath('doc1.md'), joinLines(
			`- [x]`,
			`- [X]`,
			`- [ ]`,
		));
		const workspace = store.add(new InMemoryWorkspace([doc1]));

		const diagnostics = await getComputedDiagnostics(store, doc1, workspace, { ignoreLinks: ['/doc2.md'] });
		assertDiagnosticsEqual(diagnostics, []);
	}));

	test('Should detect invalid links with titles', withStore(async (store) => {
		const doc = new InMemoryDocument(workspacePath('doc1.md'), joinLines(
			`[link](<no such.md> "text")`,
			`[link](<no such.md> 'text')`,
			`[link](<no such.md> (text))`,
			`[link](no-such.md "text")`,
			`[link](no-such.md 'text')`,
			`[link](no-such.md (text))`,
		));
		const workspace = store.add(new InMemoryWorkspace([doc]));

		const diagnostics = await getComputedDiagnostics(store, doc, workspace);
		assertDiagnosticsEqual(diagnostics, [
			makeRange(0, 8, 0, 18),
			makeRange(1, 8, 1, 18),
			makeRange(2, 8, 2, 18),
			makeRange(3, 7, 3, 17),
			makeRange(4, 7, 4, 17),
			makeRange(5, 7, 5, 17),
		]);
	}));

	test('Should generate diagnostics for non-existent header using file link to own file', withStore(async (store) => {
		const doc = new InMemoryDocument(workspacePath('sub', 'doc.md'), joinLines(
			`[bad](doc.md#no-such)`,
			`[bad](doc#no-such)`,
			`[bad](/sub/doc.md#no-such)`,
			`[bad](/sub/doc#no-such)`,
		));
		const workspace = store.add(new InMemoryWorkspace([doc]));

		const diagnostics = await getComputedDiagnostics(store, doc, workspace);
		assertDiagnosticsEqual(orderDiagnosticsByRange(diagnostics), [
			makeRange(0, 12, 0, 20),
			makeRange(1, 9, 1, 17),
			makeRange(2, 17, 2, 25),
			makeRange(3, 14, 3, 22),
		]);
	}));

	test('Own header link using file path link should be controlled by "validateMarkdownFileLinkFragments" instead of "validateFragmentLinks"', withStore(async (store) => {
		const doc1 = new InMemoryDocument(workspacePath('sub', 'doc.md'), joinLines(
			`[bad](doc.md#no-such)`,
			`[bad](doc#no-such)`,
			`[bad](/sub/doc.md#no-such)`,
			`[bad](/sub/doc#no-such)`,
		));
		const workspace = store.add(new InMemoryWorkspace([doc1]));

		const diagnostics = await getComputedDiagnostics(store, doc1, workspace, {
			validateFragmentLinks: DiagnosticLevel.ignore,
			validateMarkdownFileLinkFragments: DiagnosticLevel.warning,
		});
		assertDiagnosticsEqual(orderDiagnosticsByRange(diagnostics), [
			makeRange(0, 12, 0, 20),
			makeRange(1, 9, 1, 17),
			makeRange(2, 17, 2, 25),
			makeRange(3, 14, 3, 22),
		]);
	}));
});


suite('Diagnostic Manager', () => {
	function createManager(store: DisposableStore, workspace: InMemoryWorkspace) {
		const engine = createNewMarkdownEngine();
		const tocProvider = store.add(new MdTableOfContentsProvider(engine, workspace, nulLogger));
		const linkProvider = store.add(new MdLinkProvider(engine, workspace, tocProvider, nulLogger));
		const computer = new DiagnosticComputer(getLsConfiguration({}), workspace, linkProvider, tocProvider);
		return store.add(new DiagnosticsManager(workspace, computer));
	}

	test('Should not re-stat files on simple edits', withStore(async (store) => {
		const doc1 = new InMemoryDocument(workspacePath('doc1.md'), joinLines(
			`![i](/nosuch.png)`,
			`[ref]`,
		));
		const workspace = new InMemoryWorkspace([doc1]);

		const manager = createManager(store, workspace);
		const options = getDiagnosticsOptions({});

		const firstRequest = await manager.computeDiagnostics(doc1, options, noopToken);
		assertDiagnosticsEqual(firstRequest as MdDiagnostic[], [
			makeRange(0, 5, 0, 16),
			makeRange(1, 1, 1, 4),
		]);
		assert.strictEqual(workspace.statCallList.length, 1);

		await manager.computeDiagnostics(doc1, options, noopToken);
		assert.strictEqual(workspace.statCallList.length, 1);

		// Edit doc
		doc1.updateContent(joinLines(
			`![i](/nosuch.png)`,
			`[ref]`,
			`[ref]: http://example.com`
		))
		workspace.updateDocument(doc1);

		const thirdRequest = await manager.computeDiagnostics(doc1, options, noopToken);
		assertDiagnosticsEqual(thirdRequest as MdDiagnostic[], [
			makeRange(0, 5, 0, 16),
		]);

		await manager.computeDiagnostics(doc1, options, noopToken);
		// The file hasn't changed so we should not have re-stated it
		assert.strictEqual(workspace.statCallList.length, 1);
	}));

	test(`File delete should revalidate diagnostics`, withStore(async (store) => {
		const otherUri = workspacePath('other.png');
		const doc1 = new InMemoryDocument(workspacePath('doc.md'), joinLines(
			`![i](/other.png)`,
		));
		const workspace = new InMemoryWorkspace([doc1, otherUri]);

		const manager = createManager(store, workspace);
		const options = getDiagnosticsOptions({});

		const firstRequest = await manager.computeDiagnostics(doc1, options, noopToken);
		assertDiagnosticsEqual(firstRequest as MdDiagnostic[], []);


		// Trigger watcher change
		workspace.triggerFileDelete(otherUri);

		const thirdRequest = await manager.computeDiagnostics(doc1, options, noopToken);
		assertDiagnosticsEqual(thirdRequest as MdDiagnostic[], [
			makeRange(0, 5, 0, 15),
		]);
	}));
});
