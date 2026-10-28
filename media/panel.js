// @ts-check
(function () {
	// @ts-ignore
	const vscode = acquireVsCodeApi();
	const app = /** @type {HTMLElement} */ (document.getElementById('app'));

	/** @param {string} tag @param {Record<string, any>} [props] @param {(Node|string|undefined|false)[]} [children] */
	function el(tag, props = {}, children = []) {
		const node = document.createElement(tag);
		for (const [key, value] of Object.entries(props)) {
			if (key.startsWith('on')) {
				node.addEventListener(key.slice(2), value);
			} else if (key === 'className') {
				node.className = value;
			} else if (value !== undefined && value !== false) {
				node.setAttribute(key, value === true ? '' : value);
			}
		}
		for (const child of children) {
			if (child !== undefined && child !== false) {
				node.append(child);
			}
		}
		return node;
	}

	function copyRow(label, text) {
		return el('div', { className: 'copy-row' }, [
			el('code', {}, [text]),
			el('button', { className: 'secondary', title: `Copy ${label}`, onclick: () => vscode.postMessage({ type: 'copy', text }) }, ['Copy']),
		]);
	}

	/** Textarea saved on blur or Enter (Shift+Enter inserts a line break). */
	function editor(key, value, readOnly, save) {
		const area = /** @type {HTMLTextAreaElement} */ (el('textarea', { rows: '1', 'data-key': key, readonly: readOnly, spellcheck: 'true' }));
		area.value = value;
		area.dataset.original = value;
		const autosize = () => {
			area.style.height = 'auto';
			area.style.height = `${area.scrollHeight}px`;
		};
		const commit = () => {
			if (!readOnly && area.value !== area.dataset.original) {
				area.dataset.original = area.value;
				area.classList.add('saving');
				save(area.value);
			}
		};
		area.addEventListener('input', autosize);
		area.addEventListener('blur', commit);
		area.addEventListener('keydown', e => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				commit();
			} else if (e.key === 'Escape') {
				area.value = area.dataset.original || '';
				autosize();
			}
		});
		requestAnimationFrame(autosize);
		return area;
	}

	const KIND_LABELS = { form: 'Form', menu: 'Menu', list: 'List', tip: 'Tip', method: 'Code' };

	function render(data) {
		// Keep what is being typed when the files change underneath.
		const active = /** @type {HTMLTextAreaElement|null} */ (document.activeElement instanceof HTMLTextAreaElement ? document.activeElement : null);
		const pending = active && active.value !== active.dataset.original
			? { key: active.dataset.key, value: active.value, start: active.selectionStart, end: active.selectionEnd }
			: active ? { key: active.dataset.key, start: active.selectionStart, end: active.selectionEnd } : undefined;

		app.replaceChildren();
		if (data.missing) {
			app.append(el('p', { className: 'empty' }, [`"${data.missing}" no longer exists in the XLIFF files.`]));
			return;
		}

		const location = [data.project, data.fileName, ...data.groupPath].filter(Boolean).join(' › ');
		app.append(
			el('header', {}, [
				el('h1', {}, [data.resname]),
				el('div', { className: 'meta' }, [
					el('a', { href: '#', onclick: (e) => { e.preventDefault(); vscode.postMessage({ type: 'reveal' }); } }, [location]),
					data.id && data.id !== data.resname ? el('span', {}, [` · id ${data.id}`]) : undefined,
				]),
			]),
			el('section', {}, [
				el('h2', {}, ['Use it in 4D']),
				copyRow('the form/menu reference', data.xliffRef),
				copyRow('the code', data.localizedRef),
			]),
		);

		if (data.duplicates.length) {
			app.append(el('p', { className: 'warning' }, [`Also defined in ${data.duplicates.join(', ')}: 4D will use only one of them.`]));
		}

		const saveSource = value => vscode.postMessage({ type: 'saveSource', value });
		const translationCell = l => {
			if (l.isSource && data.mergedSource) {
				return editor('source', l.text || data.source, data.sourceReadOnly, saveSource);
			}
			if (l.status === 'missingFile') {
				return el('span', { className: 'hint' }, [`No ${l.fileLabel}`]);
			}
			if (l.status === 'missingUnit') {
				return el('div', { className: 'missing' }, [
					el('span', { className: 'hint' }, [`Missing in ${l.fileLabel}`]),
					el('button', { onclick: () => vscode.postMessage({ type: 'addToLanguage', lang: l.lang }) }, ['Add']),
				]);
			}
			return editor(`target:${l.lang}`, l.text, l.readOnly, value => vscode.postMessage({ type: 'saveTarget', lang: l.lang, value }));
		};
		const rows = [
			!data.mergedSource && el('tr', { className: 'source-row' }, [
				el('th', {}, [el('span', { className: 'lang' }, ['source']), el('div', { className: 'hint' }, [data.sourceLanguage])]),
				el('td', {}, [editor('source', data.source, data.sourceReadOnly, saveSource)]),
				el('td', { className: 'status' }, [el('span', { className: 'hint', title: 'Changes <source> in every language file' }, ['all files'])]),
			]),
			...data.languages.map(l => el('tr', { className: l.isSource && data.mergedSource ? 'source-row' : '' }, [
				el('th', {}, [
					el('span', { className: 'lang' }, [l.lang]),
					l.isSource ? el('div', { className: 'hint', title: data.mergedSource ? 'Also changes <source> in every language file' : '' }, ['source']) : undefined,
				]),
				el('td', {}, [translationCell(l)]),
				el('td', { className: 'status' }, [
					el('span', { className: `badge ${l.status}`, title: l.statusLabel }, [l.status === 'ok' ? '✓' : '!']),
					l.status !== 'missingFile' && l.status !== 'missingUnit'
						? el('a', { href: '#', title: `Open ${l.fileLabel}`, onclick: (e) => { e.preventDefault(); vscode.postMessage({ type: 'openUnit', lang: l.lang }); } }, ['open'])
						: undefined,
				]),
			])),
		];
		app.append(el('section', {}, [
			el('h2', {}, ['Translations']),
			el('table', { className: 'translations' }, [el('tbody', {}, rows)]),
			el('p', { className: 'hint' }, ['Enter saves · Shift+Enter adds a line break · Esc cancels']),
		]));

		app.append(el('section', {}, [
			el('h2', {}, [`Used in (${data.usages.length})`]),
			data.usages.length
				? el('ul', { className: 'usages' }, data.usages.map((u, index) => el('li', {}, [
					el('span', { className: `kind ${u.kind}` }, [KIND_LABELS[u.kind] || u.kind]),
					el('a', { href: '#', onclick: (e) => { e.preventDefault(); vscode.postMessage({ type: 'openUsage', index }); } }, [u.context]),
					el('span', { className: 'hint' }, [u.where]),
				])))
				: el('p', { className: 'hint' }, ['No :xliff: or Localized string reference found in forms, menus or methods. It may be used with a computed name.']),
		]));

		if (pending) {
			const area = /** @type {HTMLTextAreaElement|null} */ (app.querySelector(`textarea[data-key="${CSS.escape(pending.key || '')}"]`));
			if (area) {
				if (pending.value !== undefined) {
					area.value = pending.value;
				}
				area.focus();
				area.setSelectionRange(pending.start, pending.end);
			}
		}
	}

	window.addEventListener('message', event => {
		if (event.data.type === 'render') {
			render(event.data.data);
		}
	});
	vscode.postMessage({ type: 'ready' });
})();
