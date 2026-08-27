// Runs the compiled Harper bundle against a stubbed Joplin plugin API.
// The bundle refers to `joplin` as a free global, so it can be driven from Node.
//
// FRAME copied from joplin-plugin-cockpit's test/harness.js (fake `joplin` global, load the
// compiled dist/index.js, captured timers, instrumentation). ADAPTED for Harper: Cockpit has no
// content scripts, so `joplin.contentScripts.register`/`onMessage` are added here — the register
// calls are recorded and the onMessage handler is captured so a test can drive a lint round-trip.

const path = require('path')
const fs = require('fs')

const bundlePath = path.resolve(__dirname, '../dist/index.js')

// Plugin id from the manifest. Real Joplin namespaces every setting key as `plugin-<id>.<key>` and
// THROWS `Unknown key: plugin-<id>.<key>` the instant a plugin reads (value/values) a key it never
// registered — which is exactly how v1.1.0 died on mobile (dictionaryPath is registered on desktop
// only, but was read unconditionally). The old stub returned `undefined` for unknown keys, hiding
// that class of bug. The strict settings stub below (see makeJoplin) mirrors real Joplin instead.
const PLUGIN_ID = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../src/manifest.json'), 'utf8'),
).id

function makeJoplin(options) {
    const settings = Object.assign({}, options.initialSettings)
    const state = {
        settings,
        registeredSettings: null,
        // STRICT settings fidelity: the exact set of keys the plugin registered via
        // settings.registerSettings THIS run. settings.value()/values() throw 'Unknown key' for any
        // key not in here, mirroring real Joplin (a key registered on desktop only — dictionaryPath —
        // must never be read on mobile). Reset per run because makeJoplin builds fresh state each time.
        registeredKeys: new Set(),
        panels: [],
        dialogs: [],
        panelHtml: {},
        panelScripts: [],
        toolbarButtons: [],
        menus: [],
        // HARPER v1.4.0 (settings dialog): the dialog's construction, recorded so a test can assert the
        // pieces that make it usable at all — the CSS+JS assets, the single Close button, and
        // setFitToContent(false) (without which the dialog has no real viewport).
        dialogScripts: [],
        dialogHtml: {},
        dialogButtons: {},
        dialogFitToContent: {},
        menuItems: [],
        // Every views.*.onMessage handler by view handle, so the DIALOG's endpoint can be driven
        // directly (state.panelMessageHandler only ever holds the last one registered).
        viewMessageHandlers: {},
        // Every panels.postMessage(handle, message) — the reopen nudge is fire-and-forget, so this is
        // the only way to see it happened.
        viewPostedMessages: [],
        commands: [],
        // HARPER: every joplin.commands.execute(name, ...args), in order.
        commandExecutions: [],
        workspaceEvents: [],
        messageBoxes: [],
        notePuts: [],
        dataPosts: [],
        dataDeletes: [],
        // Every settings.setValue, so a test can assert a render wrote no profile/setting (the outside-results peek is read-only).
        settingWrites: [],
        onStart: null,
        sectionDescription: '',
        panelMessageHandler: null,
        // HARPER: every joplin.contentScripts.register(type, id, path) call, in order.
        contentScripts: [],
        // HARPER: the joplin.contentScripts.onMessage handler(s), keyed by content-script id. A test
        // captures one and calls it with {type:'lint', text} to exercise the real harper.js linter.
        contentScriptMessageHandlers: {},
        setHtmlCalls: 0,
        // An ordered log of the two events the fast-first-paint checks care about: a panel paint ('setHtml')
        // and a checkbox-count note-body fetch ('bodyFetch', a ['notes', id] GET asking only for the body).
        // Recording them in one sequence lets a test assert a paint happened BEFORE any body was fetched.
        callLog: [],
        // Optional one-shot gate for the out-of-order-paint (generation token) check: when set to
        // { promise, todos, searchNotes, onEnter }, the FIRST search awaits promise before returning the
        // given snapshot, so an older refresh can be held mid-flight while a newer one paints past it.
        searchGate: null,
        searchGateUsed: false,
        // Every data.get, recorded as { path, query }, so tests can count search round-trips, single-note
        // reads (the removed GET-before-PUT), and the folder poll's request.
        gets: [],
        // setInterval callbacks captured during startup (the periodic timer + the folder poll) so the suite
        // can drive them by hand rather than on a real clock. Each is { fn, ms, cleared }.
        intervals: [],
        // setTimeout callbacks armed by the refresh LANES (reconcile / overview) while a wrapped handler runs,
        // captured instead of scheduled on a real clock so a test can drive them by hand and assert on the
        // lane structure. Each is { cb, ms, id, cleared, fired }. clearTimeout marks cleared; fireTimeout runs
        // one (with capture active, so a re-arm during the poll is captured too).
        timeouts: [],
        // Set to a DialogResult to make the next dialogs.open() return it instead of a cancel.
        dialogResult: null,
        // Optional awaited hook run at the START of every data.put, before the write is recorded or
        // applied: `async (noteId, body) => {}`. Lets a test act while a reconcile pass is suspended
        // mid-write (see the pending-buffer race regressions in run.js).
        beforeNotePut: null,
        // The same idea one stage EARLIER: an awaited hook at the start of every single-note data.get,
        // `async (noteId, query) => {}`. A reconcile pass reads the dictionary note long before it
        // writes anything, and the buffer snapshots straddle that read — so the window that a
        // beforeNotePut injection is already past is only reachable from here.
        beforeNoteGet: null,
        // An awaited hook run once a settings.setValue is VISIBLE but before the onChange handlers:
        // `async (key, value) => {}`. The dictionary editor's save spends its whole duration in
        // per-word settings writes, so this is where a test can start a COMPETING reconcile partway
        // through one — a pass that has read the buffers as they stood after some of the words but
        // before the rest.
        afterSettingWrite: null,
    }

    const notes = options.notes || {}

    // Wraps a plugin-supplied handler so that any setTimeout it arms (the reconcile and overview lanes) is
    // captured into state.timeouts rather than scheduled on a real clock, for the duration of the awaited
    // call. Real setTimeout/clearTimeout are restored afterwards, so the suite's own timing and Node's
    // internals are untouched. The lane callbacks return their promise, so firing one is awaitable.
    function withTimerCapture(fn) {
        return async function (...args) {
            const realSetTimeout = global.setTimeout
            const realClearTimeout = global.clearTimeout
            global.setTimeout = (cb, ms) => {
                const entry = { cb, ms, id: state.timeouts.length, cleared: false, fired: false }
                state.timeouts.push(entry)
                return entry
            }
            global.clearTimeout = (handle) => {
                if (handle && typeof handle === 'object' && typeof handle.id === 'number' && state.timeouts[handle.id]) {
                    state.timeouts[handle.id].cleared = true
                }
            }
            try {
                return await fn.apply(null, args)
            } finally {
                global.setTimeout = realSetTimeout
                global.clearTimeout = realClearTimeout
            }
        }
    }
    // Runs one captured timeout by hand, with capture active so a poll that re-arms the lane is captured too.
    // A cleared or already-fired entry is a no-op. Returns the callback's promise so a test can await it.
    state.fireTimeout = (entry) => {
        if (!entry || entry.cleared || entry.fired) return undefined
        entry.fired = true
        return withTimerCapture(entry.cb)()
    }
    // Convenience: the captured lane timeouts of a given delay that are still live (neither cleared nor fired).
    state.pendingTimeouts = (ms) => state.timeouts.filter(t => t.ms === ms && !t.cleared && !t.fired)

    const joplin = {
        plugins: {
            register: (script) => { state.onStart = script.onStart },
            dataDir: async () => options.dataDir,
            installationDir: async () => options.installationDir,
        },
        require: (moduleName) => options.require(moduleName),
        contentScripts: {
            register: async (type, id, scriptPath) => { state.contentScripts.push({ type, id, path: scriptPath }) },
            onMessage: async (id, handler) => { state.contentScriptMessageHandlers[id] = handler },
        },
        versionInfo: async () => options.versionInfo,
        settings: {
            // HARPER v1.4.0: keep the section's description — it is the only in-app pointer to the
            // "Harper: Settings…" command, and Joplin renders it as literal text (no markup allowed).
            registerSection: async (name, section) => { state.sectionDescription = (section || {}).description || '' },
            registerSettings: async (defs) => {
                state.registeredSettings = defs
                for (const key of Object.keys(defs)) {
                    state.registeredKeys.add(key)
                    if (!(key in settings)) settings[key] = defs[key].value
                }
            },
            // STRICT: real Joplin throws for any key the plugin did not register (namespaced as
            // plugin-<id>.<key>). This is what makes reading an unregistered setting a HARD failure in
            // the harness — the fidelity gap that let the mobile dictionaryPath read pass silently.
            value: async (key) => {
                if (!state.registeredKeys.has(key)) {
                    throw new Error(`Unknown key: plugin-${PLUGIN_ID}.${key} (Calling api.joplin.settings.value)`)
                }
                return settings[key]
            },
            values: async (keys) => {
                const requested = Array.isArray(keys) ? keys : [...state.registeredKeys]
                const out = {}
                for (const key of requested) {
                    if (!state.registeredKeys.has(key)) {
                        throw new Error(`Unknown key: plugin-${PLUGIN_ID}.${key} (Calling api.joplin.settings.values)`)
                    }
                    out[key] = settings[key]
                }
                return out
            },
            setValue: async (key, value) => {
                state.settingWrites.push({ key, value })
                settings[key] = value
                if (state.afterSettingWrite) await state.afterSettingWrite(key, value)
                for (const handler of state.settingHandlers) await handler({ keys: [key] })
            },
            onChange: async (handler) => { state.settingHandlers.push(handler) },
        },
        commands: {
            register: async (command) => { state.commands.push(command) },
            // HARPER: record every execute() call so a test can assert the plugin poked the editor's
            // `harper.forceLint` re-lint command (via the built-in `editor.execCommand`) after a
            // settings change. Built-in commands like `editor.execCommand` aren't registered by the
            // plugin, so they just record + no-op here.
            execute: async (name, ...args) => {
                state.commandExecutions.push({ name, args })
                const command = state.commands.find(c => c.name === name)
                if (command) return await command.execute(...args)
            },
        },
        views: {
            panels: {
                create: async (id) => { state.panels.push(id); return `panel-${id}` },
                addScript: async (handle, script) => { state.panelScripts.push(script) },
                // HARPER v1.4.0: the settings DIALOG registers its handler here too — panels.onMessage
                // accepts a dialog handle (same WebviewController underneath), which is the only way to
                // talk to a dialog webview. Keyed by handle so the panel and the dialog can coexist.
                onMessage: async (handle, handler) => {
                    state.panelMessageHandler = withTimerCapture(handler)
                    state.viewMessageHandlers[handle] = withTimerCapture(handler)
                },
                postMessage: (handle, message) => { state.viewPostedMessages.push({ handle, message }) },
                setHtml: async (handle, html) => { state.setHtmlCalls++; state.callLog.push('setHtml'); state.panelHtml[handle] = html },
                show: async () => {},
                visible: async () => true,
            },
            dialogs: {
                create: async (id) => { state.dialogs.push(id); return `dialog-${id}` },
                addScript: async (handle, script) => { state.dialogScripts.push({ handle, script }) },
                setHtml: async (handle, html) => { state.dialogHtml[handle] = html },
                setButtons: async (handle, buttons) => { state.dialogButtons[handle] = buttons },
                setFitToContent: async (handle, status) => { state.dialogFitToContent[handle] = status },
                open: async () => state.dialogResult || { id: 'cancel' },
                showMessageBox: async (message) => { state.messageBoxes.push(message); return 0 },
            },
            toolbarButtons: {
                create: async (id, command, location) => { state.toolbarButtons.push({ id, command, location }) },
            },
            menuItems: {
                create: async (id, command, location, options) => { state.menuItems.push({ id, command, location, options }) },
            },
            menus: {
                create: async (id, label, items, location) => { state.menus.push({ id, label, location }) },
            },
        },
        workspace: {
            onNoteChange: async (h) => { state.workspaceEvents.push('onNoteChange'); state.noteChangeHandler = withTimerCapture(h) },
            onSyncStart: async (h) => { state.workspaceEvents.push('onSyncStart'); state.syncStartHandler = withTimerCapture(h) },
            onSyncComplete: async (h) => { state.workspaceEvents.push('onSyncComplete'); state.syncCompleteHandler = withTimerCapture(h) },
            onNoteAlarmTrigger: async (h) => { state.workspaceEvents.push('onNoteAlarmTrigger'); state.noteAlarmHandler = withTimerCapture(h) },
            // HARPER v1.1.0: the deferred-flush trigger. A test invokes state.noteSelectionChangeHandler()
            // to simulate the user leaving a note (which marks the editor closed and flushes pending words).
            onNoteSelectionChange: async (h) => { state.workspaceEvents.push('onNoteSelectionChange'); state.noteSelectionChangeHandler = h },
            selectedFolder: async () => options.selectedFolder || null,
            selectedNote: async () => options.selectedNote || null,
        },
        data: {
            get: async (pathParts, query) => {
                state.gets.push({ path: pathParts.slice(), query })
                // A checkbox-count body fetch is a single-note read asking only for the body. Log it in the
                // shared call sequence so the fast-paint checks can prove a paint preceded any body fetch.
                if (pathParts[0] === 'notes' && pathParts.length === 2 && query && Array.isArray(query.fields) && query.fields.length === 1 && query.fields[0] === 'body') {
                    state.callLog.push('bodyFetch')
                }
                if (pathParts[0] === 'search') {
                    // getTodos queries "type:todo ...", getNotes queries "type:note ...". Serve the
                    // regular-note list only to the type:note query so a showNotes profile does not
                    // list the to-do fixtures a second time as notes.
                    const q = (query && query.query) || ''
                    const hasTodo = q.includes('type:todo')
                    const hasNote = q.includes('type:note')
                    const isNoteQuery = hasNote && !hasTodo
                    // One-shot gate: the first search to arrive is held on the gate's promise and answered
                    // from the gate's own snapshot, so a test can freeze an older refresh here (with a
                    // deliberately smaller result) while a newer refresh runs to completion past it.
                    if (state.searchGate && !state.searchGateUsed) {
                        state.searchGateUsed = true
                        const gate = state.searchGate
                        if (gate.onEnter) gate.onEnter()
                        await gate.promise
                        return { items: (isNoteQuery ? (gate.searchNotes || []) : (gate.todos || [])), has_more: false }
                    }
                    if (isNoteQuery) {
                        return { items: options.searchNotes || [], has_more: false }
                    }
                    // The "results outside current filters" peek searches the user's text verbatim, with
                    // none of the type:/iscompleted:/notebook: tokens the plugin otherwise adds - so a search
                    // carrying neither type token is that peek. (Title autocomplete is also type-less, but the
                    // suite never drives it.) outsideHasMore feeds the "+more" footer.
                    if (!hasTodo && !hasNote) {
                        return { items: options.outsideResults || [], has_more: !!options.outsideHasMore }
                    }
                    // options.todos may be a function of the query, so a test can give different profiles
                    // different to-do sets (e.g. distinct ids, so a switch hits uncached checkbox bodies).
                    const todoItems = typeof options.todos === 'function' ? (options.todos(q) || []) : (options.todos || [])
                    return { items: todoItems, has_more: false }
                }
                // The notebook map and the tag autocomplete page through these endpoints.
                if (pathParts[0] === 'folders') {
                    return { items: options.folders || [], has_more: false }
                }
                if (pathParts[0] === 'tags') {
                    return { items: options.tags || [], has_more: false }
                }
                if (pathParts[0] === 'notes') {
                    // Bare ['notes'] is the search field's "recent notes" suggestion fetch.
                    if (pathParts.length === 1) return { items: options.recentNotes || [], has_more: false }
                    if (state.beforeNoteGet) await state.beforeNoteGet(pathParts[1], query)
                    const note = notes[pathParts[1]]
                    if (!note) throw new Error('Not Found')
                    // ['notes', id, 'tags'] lists the tags currently on a note (tag picker).
                    if (pathParts[2] === 'tags') return { items: note.tags || [] }
                    return note
                }
                throw new Error(`Unexpected data.get: ${pathParts}`)
            },
            put: async (pathParts, _q, body) => {
                // HARPER: an optional AWAITED hook, set by a test after run(). A note write is the widest
                // await inside a reconcile pass, so this is where a test injects the concurrent user
                // action (add-to-dictionary, a queued removal) that the pending-buffer race is about.
                if (state.beforeNotePut) await state.beforeNotePut(pathParts[1], body)
                // `fields` keeps the whole PUT body so a test can assert the exact shape (e.g. that a tick
                // writes a numeric todo_completed); `body` stays the note-body string the older checks read.
                state.notePuts.push({ id: pathParts[1], body: body.body, fields: body })
                if (notes[pathParts[1]]) Object.assign(notes[pathParts[1]], body)
            },
            post: async (pathParts, _q, body) => {
                state.dataPosts.push({ path: pathParts, body })
                return Object.assign({ id: `created-${state.dataPosts.length}` }, body)
            },
            delete: async (pathParts) => { state.dataDeletes.push(pathParts) },
        },
    }

    state.settingHandlers = []
    state.notes = notes
    // Lets a test change a public setting exactly as the app would, firing the plugin's onChange handlers (so
    // e.g. editing the visible "Excluded notebooks" field runs its resolver).
    state.setSetting = (key, value) => joplin.settings.setValue(key, value)
    return { joplin, state }
}

async function run(options) {
    const { joplin, state } = makeJoplin(options)
    global.joplin = joplin
    delete require.cache[require.resolve(bundlePath)]
    require(bundlePath)
    if (!state.onStart) throw new Error('Plugin did not register an onStart handler')
    // Capture the intervals the plugin arms at startup (the periodic refresh timer and the folder poll)
    // instead of scheduling them on a real clock: the suite invokes them by hand, and leaving many run()s'
    // worth of live intervals ticking would otherwise pollute later tests. Restored right after onStart, so
    // the test's own timers are unaffected.
    const realSetInterval = global.setInterval
    const realClearInterval = global.clearInterval
    global.setInterval = (fn, ms) => { const id = state.intervals.length; state.intervals.push({ fn, ms, cleared: false }); return id }
    global.clearInterval = (id) => { if (typeof id === 'number' && state.intervals[id]) state.intervals[id].cleared = true }
    // Handler time of the onStart PROMISE itself (v1.1.1 cold-start budget). The heavy work (engine build,
    // dictionary reads/import, start flush) is now fire-and-forget on a macrotask AFTER onStart resolves,
    // so this measures only the eager registrations — the budget test asserts it is small and that no
    // data.get/put or fs read was awaited within it.
    const onStartStartedAt = Date.now()
    try {
        await state.onStart({})
    } finally {
        state.onStartMs = Date.now() - onStartStartedAt
        global.setInterval = realSetInterval
        global.clearInterval = realClearInterval
    }
    return state
}

module.exports = { run }
