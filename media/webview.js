var vscode = acquireVsCodeApi();
var INITIAL = window.__INITIAL__ || {};

var ROW_H = 30;

// Loading state management
var loadState = {
    initialLoad: true,
    branchesLoaded: false,
    commitsLoaded: false,
    startTime: Date.now()
};

// Localized strings injected by the extension host (see src/i18n).
var I18N = window.I18N_STRINGS || {};
function T(key, params) {
    var s = I18N[key];
    if (typeof s !== 'string') return key;
    if (params) {
        for (var k in params) {
            if (Object.prototype.hasOwnProperty.call(params, k)) {
                s = s.split('{' + k + '}').join(String(params[k]));
            }
        }
    }
    return s;
}

/**
 * Custom author dropdown component with full theme support
 */
var authorDropdownState = {
    authors: [],
    filtered: [],
    selectedIndex: -1,
    isOpen: false
};

function updateAuthorDropdown(commits) {
    var dropdown = document.getElementById('author-dropdown');
    if (!dropdown) return;
    
    // Collect unique authors
    var authorSet = new Set();
    commits.forEach(function(c) {
        if (c.author) authorSet.add(c.author);
    });
    
    authorDropdownState.authors = Array.from(authorSet).sort();
    authorDropdownState.filtered = [];
    authorDropdownState.selectedIndex = -1;
    authorDropdownState.isOpen = false;
    
    // Hide dropdown initially
    dropdown.style.display = 'none';
}

function filterAuthors(query) {
    var dropdown = document.getElementById('author-dropdown');
    if (!dropdown) return;
    
    if (!query || query.trim() === '') {
        authorDropdownState.isOpen = false;
        dropdown.style.display = 'none';
        return;
    }
    
    var lowerQuery = query.toLowerCase();
    authorDropdownState.filtered = authorDropdownState.authors.filter(function(author) {
        return author.toLowerCase().includes(lowerQuery);
    });
    
    authorDropdownState.selectedIndex = -1;
    
    if (authorDropdownState.filtered.length === 0) {
        authorDropdownState.isOpen = false;
        dropdown.style.display = 'none';
        return;
    }
    
    // Render dropdown items
    dropdown.innerHTML = '';
    authorDropdownState.filtered.forEach(function(author, index) {
        var item = document.createElement('div');
        item.className = 'author-dropdown-item';
        item.textContent = author;
        item.setAttribute('data-index', index);
        
        item.addEventListener('click', function() {
            selectAuthor(index);
        });
        
        item.addEventListener('mouseenter', function() {
            highlightItem(index);
        });
        
        dropdown.appendChild(item);
    });
    
    authorDropdownState.isOpen = true;
    dropdown.style.display = 'block';
}

function selectAuthor(index) {
    var input = document.getElementById('f-author');
    if (!input || index < 0 || index >= authorDropdownState.filtered.length) return;
    
    input.value = authorDropdownState.filtered[index];
    closeAuthorDropdown();
    
    // Sync clear button visibility and trigger filter
    syncClr('f-author', 'clr-author');
    pushFilters();
}

function highlightItem(index) {
    authorDropdownState.selectedIndex = index;
    var dropdown = document.getElementById('author-dropdown');
    if (!dropdown) return;
    
    var items = dropdown.querySelectorAll('.author-dropdown-item');
    items.forEach(function(item, i) {
        if (i === index) {
            item.classList.add('active');
        } else {
            item.classList.remove('active');
        }
    });
}

function closeAuthorDropdown() {
    var dropdown = document.getElementById('author-dropdown');
    if (dropdown) {
        dropdown.style.display = 'none';
    }
    authorDropdownState.isOpen = false;
    authorDropdownState.selectedIndex = -1;
}

function handleAuthorKeydown(e) {
    if (!authorDropdownState.isOpen) return;
    
    switch(e.key) {
        case 'ArrowDown':
            e.preventDefault();
            if (authorDropdownState.selectedIndex < authorDropdownState.filtered.length - 1) {
                highlightItem(authorDropdownState.selectedIndex + 1);
            }
            break;
        case 'ArrowUp':
            e.preventDefault();
            if (authorDropdownState.selectedIndex > 0) {
                highlightItem(authorDropdownState.selectedIndex - 1);
            }
            break;
        case 'Enter':
            e.preventDefault();
            if (authorDropdownState.selectedIndex >= 0) {
                selectAuthor(authorDropdownState.selectedIndex);
            }
            break;
        case 'Escape':
            e.preventDefault();
            closeAuthorDropdown();
            break;
    }
}

var state = {
    commits: INITIAL.commits || [],
    local: INITIAL.local || [],
    remote: INITIAL.remote || [],
    favorites: INITIAL.favorites || [],
    recent: INITIAL.recent || [],
    stashes: [],
    worktrees: [],
    divergence: {},
    detailVisible: false,
    current: INITIAL.currentBranch || '',
    selectedBranch: INITIAL.selectedBranch || '',
    repoName: INITIAL.repoName || '',
    hasMore: !!INITIAL.hasMore,
    headHash: INITIAL.headHash || '',
    inProgress: INITIAL.inProgress || null,
    loadingMore: false,
    bfilter: '',
    favoritesOnly: false,
    highlight: '',
    selectedHash: null,
    selectedHashes: [], // Multi-select support
    lastClickedIndex: -1, // For Shift+click range selection
    // Which row the arrow keys are on in the tree and file list. Kept as an
    // identity (branch name / path), not an index, so a re-render can put the
    // cursor back on the same thing instead of jumping to another row.
    treeCursor: '',
    fileCursor: '',
    /** The file whose diff is shown under the list; null hides that strip. */
    preview: null,
    detail: null,
    /**
     * A stash picked in the tree, shown in place of the commit detail. It carries
     * the message/date it was taken with: the stack renumbers after a drop, so an
     * index alone would silently start naming a different stash.
     */
    stashDetail: null,
    collapsed: {},
    collapsedSec: {},
    expandedFolder: {},
    fileViewMode: 'tree',
    graphVisible: true,
    graphOverflow: false,
    repoState: 'ready',
    repoFolder: '',
    repoPendingFiles: 0,
    repositories: [],
    currentRepository: '',
    iconPack: null,
    _pendingScrollTop: null,
    _pendingRestore: null
};

/* ---------- view state persistence (Git Graph-style, via workspaceState) ---------- */
var _viewStateTimer = null;
function saveViewState() {
    if (_viewStateTimer) clearTimeout(_viewStateTimer);
    _viewStateTimer = setTimeout(function () {
        vscode.postMessage({
            command: 'saveViewState',
            state: {
                branch: state.selectedBranch || '',
                selectedHash: state.selectedHash || '',
                scrollTop: document.getElementById('scroll').scrollTop,
                detailVisible: state.detailVisible !== false,
                collapsed: state.collapsed,
                collapsedSec: state.collapsedSec,
                expandedFolder: state.expandedFolder,
                fileViewMode: state.fileViewMode || 'tree',
                graphVisible: state.graphVisible !== false
            }
        });
    }, 400);
}

// Apply a scroll position saved before the rows were rendered
function applyPendingScroll() {
    if (state._pendingScrollTop === null) return;
    document.getElementById('scroll').scrollTop = state._pendingScrollTop;
    state._pendingScrollTop = null;
}

/* ---------- session restore (survives the setData re-render on panel re-show) ---------- */
function loadDetailForRestore(hash) {
    var info = document.getElementById('d-info');
    var filesBox = document.getElementById('d-files');
    if (info) { info.innerHTML = '<div class="empty">' + T('ui.loading') + '</div>'; }
    if (filesBox) { filesBox.innerHTML = '<div class="empty">' + T('common.loadingFiles') + '</div>'; }
    state.detailVisible = true;
    applyDetailVisibility();
    // Reuse the click path so the third panel shows the message + associated file list
    vscode.postMessage({ command: 'selectCommits', hashes: [hash] });
}

// Apply a pending restore snapshot once its data is available. Works whether
// restoreViewState arrives before or after the commits message.
function applyRestoreNow() {
    var pr = state._pendingRestore;
    if (!pr) { return; }
    if (pr.collapsed) { state.collapsed = pr.collapsed; }
    if (pr.collapsedSec) { state.collapsedSec = pr.collapsedSec; }
    if (pr.expandedFolder) { state.expandedFolder = pr.expandedFolder; }
    if (pr.fileViewMode === 'tree' || pr.fileViewMode === 'flat') { state.fileViewMode = pr.fileViewMode; }
    if (typeof pr.graphVisible === 'boolean' && pr.graphVisible !== state.graphVisible) {
        state.graphVisible = pr.graphVisible;
        renderRows();   // the graph column width is baked into the row markup
    }
    if (pr.detailVisible === true) { state.detailVisible = true; }
    var commitsLoaded = (state.commits || []).length > 0;
    var target = pr.selectedHash;
    var found = !!target && (state.commits || []).some(function (c) { return c.hash === target; });
    if (found) {
        state.selectedHash = target;
        state.selectedHashes = [target];
        state.lastClickedIndex = -1;
        applyRowSelection();
        applyDetailVisibility();
        document.getElementById('scroll').scrollTop = pr.scrollTop || 0;
        loadDetailForRestore(target);
        state._pendingRestore = null;
    } else if (commitsLoaded) {
        // Target commit isn't in the loaded page: keep folds/scroll but drop the
        // snapshot so later refreshes behave normally instead of sticking.
        if (pr.scrollTop) { document.getElementById('scroll').scrollTop = pr.scrollTop; }
        applyDetailVisibility();
        state._pendingRestore = null;
    }
    // else: commits not loaded yet — keep _pendingRestore for the next data render
}

/* ---------- resizable panels ---------- */
(function initResizers() {
    var saved = vscode.getState() || {};
    if (saved.leftWidth) {
        document.getElementById('left').style.width = saved.leftWidth + 'px';
    }
    if (saved.rightWidth) {
        document.getElementById('right').style.width = saved.rightWidth + 'px';
    }
    if (saved.filesHeight) {
        document.getElementById('d-files').style.height = saved.filesHeight + 'px';
        document.getElementById('d-files').style.flex = 'none';
    }
    if (saved.previewHeight) {
        var savedPreview = document.getElementById('d-preview');
        savedPreview.style.height = saved.previewHeight + 'px';
        savedPreview.style.flex = 'none';
    }

    function setup(resizerId, panelId, minW, invert) {
        var resizer = document.getElementById(resizerId);
        var panel = document.getElementById(panelId);
        if (!resizer || !panel) return;
        var startX, startW;
        resizer.addEventListener('mousedown', function (e) {
            startX = e.clientX;
            startW = panel.offsetWidth;
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            function onMove(e) {
                var delta = e.clientX - startX;
                var newW = invert ? startW - delta : startW + delta;
                panel.style.width = Math.max(minW, newW) + 'px';
            }
            function onUp() {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                var st = vscode.getState() || {};
                st[panelId + 'Width'] = panel.offsetWidth;
                vscode.setState(st);
            }
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }

    function setupV(resizerId, targetId, minH, stateKey) {
        var resizer = document.getElementById(resizerId);
        var target = document.getElementById(targetId);
        if (!resizer || !target) return;
        var startY, startH;
        resizer.addEventListener('mousedown', function (e) {
            startY = e.clientY;
            startH = target.offsetHeight;
            document.body.style.cursor = 'row-resize';
            document.body.style.userSelect = 'none';
            function onMove(e) {
                var delta = e.clientY - startY;
                var newH = Math.max(minH, startH + delta);
                target.style.height = newH + 'px';
                target.style.flex = 'none';
            }
            function onUp() {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                var st = vscode.getState() || {};
                st[stateKey] = target.offsetHeight;
                vscode.setState(st);
            }
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }

    setup('resizer-left', 'left', 120, false);
    setup('resizer-right', 'right', 180, true);
    setupV('resizer-info', 'd-files', 60, 'filesHeight');
    setupV('resizer-preview', 'd-preview', 80, 'previewHeight');
})();

var palette = ['#d060a0','#4a90d9','#4ab07a','#d9a04a','#8a6ad0','#4ab0a8','#d0704a','#7a8ab0','#e070b0','#60c0b0','#c0b060','#8070e0'];
var laneColorCache = {};
function laneColor(name) {
    if (!laneColorCache[name]) {
        laneColorCache[name] = palette[Object.keys(laneColorCache).length % palette.length];
    }
    return laneColorCache[name];
}
function avatarColor(name) {
    var h = 0;
    for (var i = 0; i < name.length; i++) { h = (h * 31 + name.charCodeAt(i)) >>> 0; }
    return 'hsl(' + (h % 360) + ',45%,42%)';
}
// Escapes for both text nodes and quoted attributes. The DOM round-trip this
// replaced left quotes alone — text nodes do not need them escaped — but almost
// every caller interpolates into data-*="…", where a commit message or branch
// name containing a double quote would close the attribute early.
var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return ESC_MAP[c]; });
}
function fmtDate(s) {
    if (!s) return '';
    var p = String(s).split(' ');
    var day = (p[0] || '').split('-').join('/');
    var tm = (p[1] || '').slice(0, 5);
    return day + (tm ? ' ' + tm : '');
}

// Format datetime for tooltip display (YYYY-MM-DD HH:mm:ss)
function fmtDateTime(s) {
    if (!s) return '';
    try {
        var d = new Date(s);
        if (isNaN(d.getTime())) return fmtDate(s);
        var year = d.getFullYear();
        var month = String(d.getMonth() + 1).padStart(2, '0');
        var day = String(d.getDate()).padStart(2, '0');
        var hour = String(d.getHours()).padStart(2, '0');
        var minute = String(d.getMinutes()).padStart(2, '0');
        var second = String(d.getSeconds()).padStart(2, '0');
        return year + '-' + month + '-' + day + ' ' + hour + ':' + minute + ':' + second;
    } catch (e) {
        return fmtDate(s);
    }
}

// Format relative time for better readability (e.g., "2 hours ago", "3 days ago")
// For commits older than 1 day, show full datetime
function fmtRelativeTime(s) {
    if (!s) return '';
    try {
        var date = new Date(s);
        if (isNaN(date.getTime())) return fmtDate(s);
        
        var now = new Date();
        var diffMs = now - date;
        var diffSec = Math.floor(diffMs / 1000);
        var diffMin = Math.floor(diffSec / 60);
        var diffHour = Math.floor(diffMin / 60);
        var diffDay = Math.floor(diffHour / 24);
        
        // Less than 1 day: show relative time
        if (diffSec < 60) return T('time.justNow');
        if (diffMin < 60) return T('time.minutesAgo', { n: diffMin });
        if (diffHour < 24) return T('time.hoursAgo', { n: diffHour });
        
        // More than 1 day: show full datetime
        var year = date.getFullYear();
        var month = String(date.getMonth() + 1).padStart(2, '0');
        var day = String(date.getDate()).padStart(2, '0');
        var hour = String(date.getHours()).padStart(2, '0');
        var minute = String(date.getMinutes()).padStart(2, '0');
        var second = String(date.getSeconds()).padStart(2, '0');
        return year + '-' + month + '-' + day + ' ' + hour + ':' + minute + ':' + second;
    } catch (e) {
        return fmtDate(s);
    }
}

var I_BRANCH = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="4.5" cy="3.5" r="2"/><circle cx="4.5" cy="12.5" r="2"/><circle cx="11.5" cy="5.5" r="2"/><path d="M4.5 5.5v5"/><path d="M11.5 7.5c0 3-7 1.5-7 5"/></svg>';
// Same silhouette with filled nodes: the checked-out branch has to stand out in the tree.
var I_BRANCH_CURRENT = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="4.5" cy="3.5" r="2" fill="currentColor" stroke-width="1"/><circle cx="4.5" cy="12.5" r="2" fill="currentColor" stroke-width="1"/><circle cx="11.5" cy="5.5" r="2" fill="currentColor" stroke-width="1"/><path d="M4.5 5.5v5"/><path d="M11.5 7.5c0 3-7 1.5-7 5"/></svg>';
var I_CLOUD = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4.5 12a3 3 0 0 1 0-6 4 4 0 0 1 7.5 1 2.5 2.5 0 0 1-.5 5z"/></svg>';
// Archive box: the lid, the body and the slot a stash is put through.
var I_STASH = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 2.8h12v2.4H2z"/><path d="M3.2 5.2V13h9.6V5.2"/><path d="M6.4 8.1h3.2"/></svg>';
// Two overlapping folders: the same repository checked out in several places.
var I_WORKTREE = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M2 4.2h4l1 1.3h3.6v6.3H2z"/><path d="M5 2.5h4l1 1.3h3.6v6.4"/></svg>';
// Five-point star: outline means "not marked", filled is a favorite. Filled instead
// of a different glyph keeps the mark readable at 12px in any theme.
var I_STAR = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.2L8 11.6l-3.8 1.9.7-4.2-3.1-3 4.3-.6z"/></svg>';
var I_STAR_ON = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"><path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.2L8 11.6l-3.8 1.9.7-4.2-3.1-3 4.3-.6z"/></svg>';
// Rounded two-tone folder (soft fill + stroke) with a distinct open state, matching
// the stroke-based carets used across the panel. currentColor keeps it theme aware.
var I_FOLDER = '<svg width="15" height="15" viewBox="0 0 16 16"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6c.5 0 .9.2 1.2.6l.8 1.1h4.4A1.5 1.5 0 0 1 14 6.2v5.3a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7z" fill="currentColor" fill-opacity=".2" stroke="currentColor" stroke-opacity=".9" stroke-width="1.1" stroke-linejoin="round"/></svg>';
var I_FOLDER_OPEN = '<svg width="15" height="15" viewBox="0 0 16 16"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6c.5 0 .9.2 1.2.6l.8 1.1h4.4A1.5 1.5 0 0 1 14 6.2V7H2v-2.5z" fill="currentColor" fill-opacity=".2" stroke="currentColor" stroke-opacity=".9" stroke-width="1.1" stroke-linejoin="round"/><path d="M2 7.8h12l-1.2 4.3a1.5 1.5 0 0 1-1.4 1.1H3.6a1.5 1.5 0 0 1-1.4-1.1L2 8.6" fill="currentColor" fill-opacity=".2" stroke="currentColor" stroke-opacity=".9" stroke-width="1.1" stroke-linejoin="round"/></svg>';
var I_FILE = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3.5 1.5h6l3 3v10h-9z"/></svg>';
// VSCode-explorer-style chevrons (theme-aware via currentColor)
var I_CARET_R = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>';
var I_CARET_D = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>';
// File list mode switch icons: indented tree vs. flat rows (theme-aware via currentColor)
var I_TREE_MODE = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M2 3h4"/><path d="M6 6.5h4"/><path d="M6 12.5h4"/><path d="M2 9.5h4"/><path d="M4 3v9.5"/></svg>';
var I_FLAT_MODE = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M2 3.5h12"/><path d="M2 8h12"/><path d="M2 12.5h12"/></svg>';

/* ---------- workbench file-icon theme ---------- */
function applyIconFont(pack) {
    var el = document.getElementById('icon-font-style');
    if (!pack || !pack.font) {
        if (el) {el.remove();}
        return;
    }
    if (!el) {
        el = document.createElement('style');
        el.id = 'icon-font-style';
        document.head.appendChild(el);
    }
    el.textContent = '@font-face{font-family:' + JSON.stringify(pack.font.family) + ';src:url(' + JSON.stringify(pack.font.url) + ');format("woff");}';
}

/** Same precedence the explorer uses: exact name, then longest extension, then default. */
function iconDefForFile(name) {
    var pack = state.iconPack;
    if (!pack) {return null;}
    var lower = String(name).toLowerCase();
    var slash = Math.max(lower.lastIndexOf('/'), lower.lastIndexOf('\\'));
    if (slash >= 0) {lower = lower.slice(slash + 1);}
    var defId = pack.fileNames[lower];
    if (!defId) {
        var dot = lower.indexOf('.');
        while (dot > 0 && !defId) {
            defId = pack.fileExtensions[lower.slice(dot + 1)];
            dot = lower.indexOf('.', dot + 1);
        }
    }
    defId = defId || pack.file;
    return defId ? (pack.defs[defId] || null) : null;
}

/** Theme icon markup, or the built-in fallback when the theme has nothing for it. */
function iconHtml(def, fallback) {
    if (!def) {return fallback;}
    if (def.url) {return '<img class="fi" src="' + esc(def.url) + '" alt="">';}
    if (def.glyph) {
        var style = 'font-family:' + esc(state.iconPack.font ? state.iconPack.font.family : 'inherit');
        if (def.color) {style += ';color:' + esc(def.color);}
        return '<span class="fi fi-glyph" style="' + style + '">' + esc(def.glyph) + '</span>';
    }
    return fallback;
}

/* ---------- left branch tree ---------- */
function renderTree() {
    // Show skeleton on initial load if branches not loaded yet
    if (loadState.initialLoad && !loadState.branchesLoaded) {
        document.getElementById('btree').innerHTML = renderBranchSkeleton();
        return;
    }
    
    var q = state.bfilter.toLowerCase();
    // The favorites toggle narrows the tree exactly like the text filter does: only
    // matching rows are drawn and every folder opens up for them.
    var narrowing = !!q || state.favoritesOnly;
    function match(n) {
        if (q && n.toLowerCase().indexOf(q) < 0) {return false;}
        if (state.favoritesOnly && state.favorites.indexOf(n) < 0) {return false;}
        return true;
    }
    var branchRows = 0;
    function item(n, icon, depth, label) {
        var isCur = n === state.current;
        if (isCur) {icon = I_BRANCH_CURRENT;}
        var cls = 'bitem' + (n === state.selectedBranch ? ' sel' : '') + (isCur ? ' cur' : '') + (n === state.highlight ? ' hl' : '');
        var d = state.divergence[n];
        var arrows = '';
        
        // Display only the last path segment inside folders; data-branch and
        // tooltip keep the FULL name so checkout/other ops use the correct ref.
        var displayName = label || n;
        
        // Build tooltip: always show full branch name, add ahead/behind info based on arrows
        var tooltipText = n; // Always show full branch name
        if (d) {
            if (d.behind > 0) {
                arrows += '<span class="barr down" data-title="' + esc(T('w.divergeBehind', { n: d.behind })) + '">&#8595;</span>';
                tooltipText += '\n' + T('w.divergeBehind', { n: d.behind });
            }
            if (d.ahead > 0) {
                arrows += '<span class="barr up" data-title="' + esc(T('w.divergeAhead', { n: d.ahead })) + '">&#8593;</span>';
                tooltipText += '\n' + T('w.divergeAhead', { n: d.ahead });
            }
        }
        
        branchRows++;
        return '<div class="' + cls + '" data-branch="' + esc(n) + '" data-title="' + esc(tooltipText) + '" style="padding-left:' + (20 + depth * 12) + 'px">' + icon + '<span class="bname">' + esc(displayName) + '</span>' +
            (state.favorites.indexOf(n) >= 0 ? '<span class="bmark" data-title="' + esc(T('w.favoriteMark')) + '">' + I_STAR_ON + '</span>' : '') + arrows + '</div>';
    }
    function build(names) {
        var root = { children: {}, leaves: [] };
        names.forEach(function (n) {
            var parts = n.split('/');
            var node = root;
            for (var i = 0; i < parts.length - 1; i++) {
                if (!node.children[parts[i]]) node.children[parts[i]] = { children: {}, leaves: [] };
                node = node.children[parts[i]];
            }
            node.leaves.push(n);
        });
        return root;
    }
    function countLeaves(node) {
        var c = node.leaves.filter(match).length;
        Object.keys(node.children).forEach(function (k) { c += countLeaves(node.children[k]); });
        return c;
    }
    function renderNode(node, prefix, depth, icon, out) {
        Object.keys(node.children).sort().forEach(function (k) {
            var p = prefix ? prefix + '/' + k : k;
            var child = node.children[k];
            var cnt = countLeaves(child);
            if (narrowing && cnt === 0) return;
            var expanded = narrowing || !!state.expandedFolder[p];
            var folderCaret = expanded ? I_CARET_D : I_CARET_R;
            out.push('<div class="bfolder" data-folder="' + esc(p) + '" style="padding-left:' + (8 + depth * 16) + 'px">' +
                '<span class="caret">' + folderCaret + '</span>' + (expanded ? I_FOLDER_OPEN : I_FOLDER) +
                '<span class="bname">' + esc(k) + '</span><span class="count">' + cnt + '</span></div>');
            if (expanded) renderNode(child, p, depth + 1, icon, out);
        });
        node.leaves.filter(match).sort().forEach(function (n) { out.push(item(n, icon, depth, n.split('/').pop())); });
    }
    function header(key, title, count) {
        var collapsed = !!state.collapsedSec[key];
        var sectionCaret = collapsed ? I_CARET_R : I_CARET_D;
        var caret = '<span class="caret">' + sectionCaret + '</span>';
        var cnt = count === undefined ? '' : '<span class="count">' + count + '</span>';
        return '<div class="bsec" data-sec="' + key + '">' + caret + (collapsed ? I_FOLDER : I_FOLDER_OPEN) + '<span>' + esc(title) + '</span>' + cnt + '</div>';
    }
    function section(key, title, list, icon) {
        var total = list.filter(match).length;
        // While narrowing, a section header with no rows under it is just clutter.
        if (narrowing && total === 0) {return '';}
        var s = header(key, title, total);
        if (!state.collapsedSec[key]) {
            var out = [];
            renderNode(build(list), '', 0, icon, out);
            s += out.join('');
        }
        return s;
    }
    // Favorites no longer get their own pinned section: the marks live on the
    // branch rows themselves, and the toolbar star narrows the tree to them.
    // Stash rows carry no branch, so they are not .bitem: the tree's dblclick ->
    // checkout handler must never fire on them.
    function stashItem(entry) {
        var ref = 'stash@{' + entry.index + '}';
        var label = entry.message || ref;
        var when = fmtRelativeTime(entry.date);
        var tooltip = ref + '\n' + label + (when ? '\n' + when : '');
        var sel = state.stashDetail && state.stashDetail.index === entry.index ? ' sel' : '';
        return '<div class="sitem' + sel + '" data-stash="' + entry.index + '" data-title="' + esc(tooltip) + '" style="padding-left:20px">' +
            I_STASH + '<span class="bname">' + esc(label) + '</span>' +
            (when ? '<span class="sdate">' + esc(when) + '</span>' : '') + '</div>';
    }
    function stashSection() {
        if (state.stashes.length === 0) {return '';}
        var visible = state.stashes.filter(function (s) { return match(s.message || ''); });
        if (narrowing && visible.length === 0) {return '';}
        var s = header('stash', T('w.stashSection'), visible.length);
        if (!state.collapsedSec['stash']) {
            visible.forEach(function (entry) { s += stashItem(entry); });
        }
        return s;
    }
    // Worktrees are branches checked out elsewhere. The section stays out of the
    // way until there is something to compare: a lone current worktree tells the
    // user nothing. Rows open on double-click; a single click opening a whole
    // window would be too easy to trigger while browsing.
    function worktreeItem(entry) {
        var name = entry.path.split(/[\\/]/).filter(Boolean).pop() || entry.path;
        var branch = entry.branch || T('w.worktreeDetached');
        var tip = entry.path + '\n' + branch;
        if (entry.head) {tip += '\n' + entry.head.substring(0, 7);}
        if (entry.isCurrent) {tip += '\n' + T('w.worktreeCurrent');}
        else {tip += '\n' + T('w.worktreeOpenHint');}
        if (entry.lockReason) {tip += '\n' + entry.lockReason;}
        var cls = 'witem' + (entry.isCurrent ? ' cur' : '') + (entry.main ? ' main' : '');
        return '<div class="' + cls + '" data-worktree="' + esc(entry.path) + '" data-title="' + esc(tip) + '" style="padding-left:20px">' +
            I_WORKTREE + '<span class="bname">' + esc(name) + '</span>' +
            '<span class="sdate">' + esc(entry.isCurrent ? T('w.worktreeCurrent') : branch) + '</span></div>';
    }
    function worktreeSection() {
        var visible = state.worktrees.filter(function (w) { return !w.prunable; });
        if (visible.length <= 1) {return '';}
        var s = header('worktree', T('w.worktreeSection'), visible.length);
        if (!state.collapsedSec['worktree']) {
            visible.forEach(function (entry) { s += worktreeItem(entry); });
        }
        return s;
    }
    var head = '';
    if (state.current) {
        var resumeHtml = '';
        if (state.cherryPickResume && state.cherryPickResume.remainingHashes.length > 0) {
            var count = state.cherryPickResume.remainingHashes.length;
            resumeHtml = '<div class="cherry-pick-resume" data-action="resumeCherryPick">' + 
                '<span class="resume-icon">&#9654;</span>' + 
                T('w.resumeCherryPick', { count: count, hash: state.cherryPickResume.conflictHash }) + 
                '</div>';
        }
        // The current branch is a branch like any other, so the filter applies to
        // it too — otherwise "only favorites" would still list an unmarked row.
        // The resume banner is an action prompt, not a listing, so it stays.
        if (match(state.current)) {
            head = header('head', T('w.headSection')) +
                (state.collapsedSec['head'] ? '' : item(state.current, I_BRANCH, 0));
        }
        head += resumeHtml;
    }
    var tree = '<div id="btree-inner">' + head +
        section('local', T('common.local'), state.local, I_BRANCH) +
        section('remote', T('common.remote'), state.remote, I_CLOUD) +
        stashSection() + worktreeSection() + '</div>';
    // Nothing marked yet: a tree of empty section headers reads as a broken list
    // instead of "mark a branch first", so replace it with the instruction.
    if (state.favoritesOnly && branchRows === 0) {
        tree = '<div class="empty">' + esc(T('w.noFavorites')) + '</div>';
    }
    document.getElementById('btree').innerHTML = tree;
    syncFavFilterBtn();
    applyTreeCursor();
}

/* ---------- center commit list ---------- */

/** What #rows holds right now. An appended page extends it instead of painting
 *  every loaded row again — see renderRows(appendOnly). */
var rowsPainted = { count: 0, graphW: -1 };

/** Mark the refs cells whose badges run past the column, so the CSS fades them out.
 *  All widths are read before the first class is written: interleaving a read with a
 *  write invalidates the layout and forces one synchronous reflow per row. */
function markRefsOverflow(refsList) {
    var flags = [];
    for (var i = 0; i < refsList.length; i++) {
        flags.push(refsList[i].scrollWidth > refsList[i].clientWidth);
    }
    for (var j = 0; j < refsList.length; j++) {
        if (flags[j]) {refsList[j].classList.add('has-overflow');}
    }
}

function renderRows(appendOnly) {
    var list = state.commits;
    if (list.length === 0) {
        rowsPainted = { count: 0, graphW: -1 };
        // Show skeleton loading on initial load, empty message otherwise
        if (loadState.initialLoad && !loadState.commitsLoaded) {
            document.getElementById('rows').innerHTML = renderCommitSkeleton(5);
            return;
        }
        document.getElementById('rows').innerHTML = '<div class="empty">' + T('w.noMatch') + '</div>';
        document.getElementById('rows').style.minWidth = '';
        removeGraphCanvas();
        return;
    }
    
    // Mark as loaded
    if (loadState.initialLoad) {
        loadState.commitsLoaded = true;
        loadState.initialLoad = false;
        hideInitialLoading();
    }

    var rowOf = {};
    list.forEach(function (c, i) { rowOf[c.hash] = i; });

    // Compute lane assignment for each commit
    var lanes = [];
    var laneLastRow = [];
    var commitLane = {};
    // Lane columns are capped on purpose: past ~20 concurrent branches the graph is
    // unreadable anyway, and an uncapped column pushes the commit messages out of view.
    // The last column is reserved as an overflow lane that extra chains share.
    var MAX_LANES = 24;
    var OVERFLOW_LANE = MAX_LANES - 1;
    var graphOverflow = false;
    function chainContinues(hash, i) {
        var j = rowOf[hash];
        return j !== undefined && j > i;
    }
    function newLane() {
        lanes.push({ pending: null, color: null });
        laneLastRow.push(undefined);
        return lanes.length - 1;
    }
    function slotLane() {
        for (var i = 0; i < lanes.length; i++) { if (i < OVERFLOW_LANE && !lanes[i].pending) return i; }
        if (lanes.length < OVERFLOW_LANE) {return newLane();}
        graphOverflow = true;
        while (lanes.length <= OVERFLOW_LANE) {newLane();}
        return OVERFLOW_LANE;
    }
    list.forEach(function (c, i) {
        var expecting = [];
        for (var k = 0; k < lanes.length; k++) if (lanes[k].pending === c.hash) expecting.push(k);
        var li = expecting.length ? expecting[0] : slotLane();
        var refName = (c.refs || []).filter(function (r) { return r !== 'HEAD'; })[0];
        if (!lanes[li].color) lanes[li].color = laneColor(refName || ('anon' + li));
        commitLane[c.hash] = li;
        laneLastRow[li] = i;
        for (var e = 1; e < expecting.length; e++) lanes[expecting[e]].pending = null;
        // Hold the lane only while the first parent is actually in this page — a chain
        // that leaves the loaded window can never be drawn and would leak the column.
        var p0 = c.parents[0];
        lanes[li].pending = (li !== OVERFLOW_LANE && p0 && chainContinues(p0, i)) ? p0 : null;
        for (var pi = 1; pi < c.parents.length; pi++) {
            var ph = c.parents[pi];
            if (!chainContinues(ph, i)) {continue;}
            var nl = slotLane();
            if (!lanes[nl].color) lanes[nl].color = laneColor('merge' + i + '_' + pi);
            if (nl !== OVERFLOW_LANE) lanes[nl].pending = ph;
        }
    });

    var laneW = 12;
    state.graphOverflow = graphOverflow;
    var graphW = state.graphVisible === false ? 0 : Math.max(lanes.length, 1) * laneW + 8;
    var totalH = list.length * ROW_H;

    // Build HTML rows (without dots). In append mode the already-painted rows are
    // not even turned into markup again: only the incoming page touches the DOM.
    var append = appendOnly === true && rowsPainted.count > 0 && rowsPainted.graphW === graphW;
    var from = append ? rowsPainted.count : 0;
    var parts = [];
    list.forEach(function (c, i) {
        if (i < from) {parts.push(''); return;}
        var html = '';
        var chips = '';
        (c.refs || []).forEach(function (r) {
            if (r === 'HEAD') return;
            
            // Determine ref type for styling. Tags are known by the host (it read
            // refs/tags), so the badge never guesses from the name's shape.
            var isTag = (c.tags || []).indexOf(r) >= 0;
            var isBranch = !r.includes('/') && !isTag;
            var isRemote = r.indexOf('origin/') === 0 || r.indexOf('remotes/') === 0;

            var cls = 'chip';
            if (isTag) {
                cls += ' tag'; // Yellow badge for tags
            } else if (r === state.current) {
                cls += ' cur';
            } else if (isRemote) {
                cls += ' remote';
            }
            
            chips += '<span class="' + cls + '">' + esc(r) + '</span>';
        });

        // Build tooltip with all available info including branches
        var commitTooltip = '';
        
        // Line 1: Commit message (bold emphasis, first line only)
        var firstLine = esc(c.message).split('\n')[0];
        commitTooltip += firstLine + '\n';
        
        // Line 2: Author and date
        commitTooltip += T('w.authorPrefix') + esc(c.author || '') + '\n';
        commitTooltip += T('w.timePrefix') + fmtDateTime(c.date) + '\n';
        
        // Add branch refs to tooltip if available
        if (c.refs && c.refs.length > 0) {
            var localBranches = [];
            var remoteBranches = [];
            c.refs.forEach(function(r) {
                if (r === 'HEAD') return;
                if (r.indexOf('/') !== -1) {
                    remoteBranches.push(r);
                } else {
                    localBranches.push(r);
                }
            });
            
            if (localBranches.length > 0 || remoteBranches.length > 0) {
                commitTooltip += '\n'; // Separator line
                
                // Local branches
                if (localBranches.length > 0) {
                    commitTooltip += T('w.localBranchesPrefix') + localBranches.map(esc).join(', ') + '\n';
                }

                // Remote branches (strip remote name prefix like origin/)
                if (remoteBranches.length > 0) {
                    var remoteNames = remoteBranches.map(function(rb) {
                        var parts = rb.split('/');
                        return parts.length > 1 ? parts.slice(1).join('/') : rb;
                    });
                    commitTooltip += T('w.remoteBranchesPrefix') + remoteNames.map(esc).join(', ') + '\n';
                }
            }
        }

        html += '<div class="row' + (c.hash === state.selectedHash ? ' sel' : '') + '" data-hash="' + esc(c.hash) + '">';
        html += '<div class="garea" style="width:' + graphW + 'px"></div>';
        html += '<div class="refs">' + chips + '</div>';
        // Display only first line of commit message in list
        var displayMessage = esc(c.message).split('\n')[0];
        html += '<div class="msg" data-title="' + commitTooltip + '">' + displayMessage + '</div>';
        html += '<div class="rauthor" data-title="' + commitTooltip + '">' + esc(c.author || '') + '</div>';
        html += '<div class="rdate" data-title="' + commitTooltip + '">' + esc(fmtRelativeTime(c.date)) + '</div>';
        html += '<div class="avatar" style="background:' + avatarColor(c.author || '?') + '">' + esc((c.author || '?').charAt(0).toUpperCase()) + '</div>';
        html += '</div>';
        parts.push(html);
    });

    var wrap = document.getElementById('rows');
    if (from > 0) {
        // The canvas sits at index 0, so the appended rows are always the tail.
        var kids = wrap.children;
        var before = kids.length;
        wrap.insertAdjacentHTML('beforeend', parts.slice(from).join(''));
        var fresh = [];
        for (var k = before; k < kids.length; k++) {
            var cell = kids[k].querySelector('.refs');
            if (cell) {fresh.push(cell);}
        }
        markRefsOverflow(fresh);
    } else {
        wrap.innerHTML = parts.join('');
        wrap.style.minWidth = (graphW + 500) + 'px';
        markRefsOverflow(wrap.querySelectorAll('.refs'));
    }
    rowsPainted = { count: list.length, graphW: graphW };

    // Draw graph on canvas overlay
    drawGraphCanvas(list, lanes, commitLane, laneLastRow, laneW, graphW, totalH, rowOf);
    updateGraphToggleUi();
}

/**
 * Toggle the 'sel' class in place — used when only the selection changed,
 * avoiding a full rows rebuild + canvas redraw.
 */
function applyRowSelection() {
    var rows = document.querySelectorAll('#rows .row');
    for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var hash = row.getAttribute('data-hash');
        var isSelected = state.selectedHashes.indexOf(hash) >= 0;
        var currentlySelected = row.classList.contains('sel');
        // Only update if selection state actually changed
        if (isSelected !== currentlySelected) {
            row.classList.toggle('sel', isSelected);
        }
    }
}

/** The rows the list currently shows, in display order — the keyboard counts these. */
function commitRowList() {
    return Array.from(document.querySelectorAll('#rows .row'));
}

/**
 * Move the selection to the row at `index`; with `extend` the range from the
 * last anchor is selected, exactly like Shift+click, so both paths obey one rule.
 */
function selectCommitIndex(index, extend) {
    var rows = commitRowList();
    if (rows.length === 0) {return false;}
    var at = Math.max(0, Math.min(index, rows.length - 1));
    var hash = rows[at].getAttribute('data-hash');
    if (!hash) {return false;}

    var anchor = (state.lastClickedIndex >= 0 && state.lastClickedIndex < rows.length)
        ? state.lastClickedIndex : at;
    if (extend) {
        var start = Math.min(anchor, at), end = Math.max(anchor, at);
        state.selectedHashes = [];
        for (var i = start; i <= end; i++) {
            var h = rows[i].getAttribute('data-hash');
            if (h) {state.selectedHashes.push(h);}
        }
    } else {
        state.selectedHashes = [hash];
        state.lastClickedIndex = at;
    }
    // The row under the cursor is the "current" one even when extending upward,
    // where the last hash in the range would be the other end of it.
    state.selectedHash = hash;
    state.fileCursor = '';
    applyRowSelection();
    rows[at].scrollIntoView({ block: 'nearest' });
    loadSelectedDetail();
    return true;
}

/** Ask the host for the detail pane of the current selection (single or merged). */
function loadSelectedDetail() {
    if (state.stashDetail) {
        // The tree still marks the stash row; a commit selection takes over.
        state.stashDetail = null;
        renderTree();
    }
    // The file list is about to be replaced, so a diff of one of its rows would
    // describe a file that may not even be in the new commit.
    clearPreview();
    if (state.selectedHashes.length === 0) {
        state.multiCommits = null;
        state.multiFiles = null;
        state.detail = null;
        renderDetail();
        saveViewState();
        return;
    }
    state.detail = null;
    state.multiCommits = null; // Clear old multi-commit data
    state.multiFiles = null;
    state.detailVisible = true;

    var info = document.getElementById('d-info');
    var filesBox = document.getElementById('d-files');
    info.innerHTML = '<div class="empty">' + T('ui.loading') + '</div>';
    filesBox.innerHTML = '<div class="empty">' + T('common.loadingFiles') + '</div>';

    saveViewState();
    vscode.postMessage({ command: 'selectCommits', hashes: state.selectedHashes });
}

/**
 * Render details for multiple selected commits (merged view)
 */
function renderMultiCommitDetail(info, filesBox) {
    var commits = state.multiCommits || [];
    
    // Show commit count header
    var header = '<div class="multi-select-header">';
    header += '<span class="multi-count">' + T('common.commitCount', { n: commits.length }) + '</span>';
    header += '</div>';
    
    // The host returns these oldest → newest, so the order the user clicked
    // (Ctrl+click picks in any order at all) never reaches the display.
    var msgHtml = '<div class="multi-commit-list">';
    commits.forEach(function(c) {
        msgHtml += '<div class="multi-commit-item" data-hash="' + esc(c.hash) + '">';
        msgHtml += '<span class="hashchip">' + esc(c.shortHash) + '</span>';
        msgHtml += '<span class="cmsg">' + esc(c.message || T('commit.noMessage')) + '</span>';
        msgHtml += '<span class="cmeta">' + esc(c.author) + ' · ' + esc(fmtRelativeTime(c.date)) + '</span>';
        msgHtml += '</div>';
    });
    msgHtml += '</div>';
    
    info.innerHTML = header + msgHtml;
    
    // One row per path, already merged, counted and ordered by the host.
    var mergedFiles = state.multiFiles || [];
    
    if (mergedFiles.length === 0) {
        filesBox.innerHTML = '<div class="empty">' + T('common.noFileChanges') + '</div>';
        return;
    }
    
    // Build file tree
    var mode = state.fileViewMode || FILE_MODE_TREE;
    var fh = fileHeadHtml(mergedFiles.length, mode);
    fh += buildFileRows(mergedFiles, mode, state.collapsed, detailFileRowHtml);

    filesBox.innerHTML = '<div id="d-files-inner">' + fh + '</div>';
    applyFileCursor();
}

/**
 * Draw the commit graph using Canvas API for pixel-perfect alignment.
 */
function removeGraphCanvas() {
    var canvas = document.querySelector('#rows canvas.graph-canvas');
    if (canvas && canvas.parentNode) {canvas.parentNode.removeChild(canvas);}
}

/** Reflect the graph column state on the toolbar toggle (label + overflow hint). */
function updateGraphToggleUi() {
    var btn = document.getElementById('tg-graph');
    if (!btn) {return;}
    var hidden = state.graphVisible === false;
    var label = T(hidden ? 'ui.showGraph' : 'ui.hideGraph');
    if (!hidden && state.graphOverflow) {label += ' · ' + T('ui.graphOverflow');}
    btn.setAttribute('data-title', label);
    btn.classList.toggle('off', hidden);
    btn.classList.toggle('warn', !hidden && !!state.graphOverflow);
}

function drawGraphCanvas(list, lanes, commitLane, laneLastRow, laneW, graphW, totalH, rowOf) {
    var wrap = document.getElementById('rows');
    if (graphW <= 0) {
        removeGraphCanvas();
        return;
    }
    var firstGarea = wrap.querySelector('.garea');
    if (!firstGarea) return;

    // Create or reuse canvas
    var canvas = wrap.querySelector('canvas.graph-canvas');
    if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.className = 'graph-canvas';
        canvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:1;';
        wrap.style.position = 'relative';
        wrap.insertBefore(canvas, wrap.firstChild);
    }

    var dpr = window.devicePixelRatio || 1;
    canvas.width = graphW * dpr;
    canvas.height = totalH * dpr;
    canvas.style.width = graphW + 'px';
    canvas.style.height = totalH + 'px';

    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, graphW, totalH);

    function lx(l) { return l * laneW + laneW / 2; }
    function ry(i) { return i * ROW_H + ROW_H / 2; }

    // Draw connection lines
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    list.forEach(function (c, i) {
        var a = commitLane[c.hash];
        c.parents.forEach(function (p) {
            var j = rowOf[p];
            if (j === undefined || j <= i) return;
            var b = commitLane[p];
            var color = lanes[a].color || '#888';
            ctx.strokeStyle = color;
            ctx.globalAlpha = 0.7;

            if (a === b) {
                // Straight vertical line
                ctx.beginPath();
                ctx.moveTo(lx(a), ry(i));
                ctx.lineTo(lx(b), ry(j));
                ctx.stroke();
            } else {
                // L-shaped path: down then horizontal
                ctx.beginPath();
                ctx.moveTo(lx(a), ry(i));
                ctx.lineTo(lx(a), ry(j));
                ctx.lineTo(lx(b), ry(j));
                ctx.stroke();
            }
        });
    });

    // Draw trailing lines for active lanes
    lanes.forEach(function (l, idx) {
        if (l.pending && laneLastRow[idx] !== undefined && laneLastRow[idx] < list.length - 1) {
            ctx.strokeStyle = l.color || '#888';
            ctx.globalAlpha = 0.7;
            ctx.beginPath();
            ctx.moveTo(lx(idx), ry(laneLastRow[idx]));
            ctx.lineTo(lx(idx), ry(list.length - 1));
            ctx.stroke();
        }
    });

    // Draw commit dots
    list.forEach(function (c, i) {
        var li = commitLane[c.hash];
        var refName = (c.refs || []).filter(function (r) { return r !== 'HEAD'; })[0];
        var isHead = !!refName && (c.refs || []).indexOf(state.current) >= 0;
        var color = lanes[li].color || '#888';
        var x = lx(li);
        var y = ry(i);
        var radius = 4;

        ctx.globalAlpha = 1;

        if (isHead) {
            // Head commit: outer ring + inner dot
            ctx.beginPath();
            ctx.arc(x, y, radius + 2, 0, Math.PI * 2);
            ctx.fillStyle = '#1e1e1e'; // Background color for gap
            ctx.fill();

            ctx.beginPath();
            ctx.arc(x, y, radius + 2, 0, Math.PI * 2);
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(x, y, radius, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
        } else {
            // Normal commit: solid dot
            ctx.beginPath();
            ctx.arc(x, y, radius, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
        }
    });
}

/* ---------- right detail panel ---------- */
function countFiles(node) {
    var n = 0;
    Object.keys(node.children).forEach(function (k) {
        var ch = node.children[k];
        n += ch.isDir ? countFiles(ch) : 1;
    });
    return n;
}

/* ---------- file list: flat vs directory tree (shared by detail panel and dialogs) ---------- */
var FILE_MODE_TREE = 'tree';
var FILE_MODE_FLAT = 'flat';

/** Build a dir/file tree from repo-relative paths. */
function buildFileTree(files) {
    var root = { children: {} };
    files.forEach(function (f) {
        var parts = f.path.split('/');
        var node = root;
        for (var i = 0; i < parts.length; i++) {
            var name = parts[i];
            if (!node.children[name]) { node.children[name] = { children: {}, isDir: i < parts.length - 1, file: null }; }
            if (i === parts.length - 1) { node.children[name].isDir = false; node.children[name].file = f; }
            node = node.children[name];
        }
    });
    return root;
}

/**
 * Render file rows in the given mode. rowFn(ctx) returns the row markup for
 * { kind: 'dir'|'file', name, path, depth, closed, count, file }.
 * Flat mode lists every file with its full path, in the source order.
 */
function buildFileRows(files, mode, collapsed, rowFn) {
    if (mode !== FILE_MODE_TREE) {
        return files.map(function (f) {
            return rowFn({ kind: 'file', name: f.path, path: f.path, depth: 0, count: 0, file: f });
        }).join('');
    }
    var out = [];
    (function walk(node, depth, prefix) {
        var keys = Object.keys(node.children).sort(function (a, b) {
            var na = node.children[a], nb = node.children[b];
            if (na.isDir !== nb.isDir) {return na.isDir ? -1 : 1;}
            return a.localeCompare(b);
        });
        keys.forEach(function (k) {
            var ch = node.children[k];
            var p = prefix ? prefix + '/' + k : k;
            if (ch.isDir) {
                var closed = !!collapsed[p];
                out.push(rowFn({ kind: 'dir', name: k, path: p, depth: depth, closed: closed, count: countFiles(ch) }));
                if (!closed) {walk(ch, depth + 1, p);}
            } else {
                out.push(rowFn({ kind: 'file', name: k, path: ch.file.path, depth: depth, count: 0, file: ch.file }));
            }
        });
    })(buildFileTree(files), 0, '');
    return out.join('');
}

/** Icon button offering the opposite of the current file list mode. */
function fileModeBtnHtml(mode) {
    var toTree = mode !== FILE_MODE_TREE;
    var label = T(toTree ? 'fileMode.showTree' : 'fileMode.showFlat');
    return '<button class="fmode-btn" data-fmode="' + (toTree ? FILE_MODE_TREE : FILE_MODE_FLAT) + '" data-title="' + esc(label) + '">' + (toTree ? I_TREE_MODE : I_FLAT_MODE) + '</button>';
}

/** Header row of the commit-detail file list; the inner group is pinned on both scroll axes. */
function fileHeadHtml(count, mode) {
    return '<div class="fhead"><div class="fhead-inner"><span>' + T('w.filesCount', { n: count }) + '</span>' + fileModeBtnHtml(mode) + '</div></div>';
}

function fileRowPad(depth) {
    return 'padding-left:' + (8 + depth * 14) + 'px';
}

function applyDetailVisibility() {
    document.getElementById('main').classList.toggle('no-detail', !state.detailVisible);
    var tg = document.getElementById('tg-files');
    tg.title = state.detailVisible ? T('w.hideDetail') : T('w.showDetail');
    tg.classList.toggle('off', !state.detailVisible);
}

/** The stash picked in the tree: its own card, then the files it carries. */
function renderStashDetail(info, filesBox) {
    var s = state.stashDetail;
    var ref = 'stash@{' + s.index + '}';
    var tip = esc(ref) + '\n' + esc(s.message || '') + (s.date ? '\n' + esc(fmtDateTime(s.date)) : '');
    var mh = '<div class="ccard" data-title="' + tip + '">';
    mh += '<div class="crow"><span class="hashchip">' + esc(ref) + '</span><span class="cmeta">' + esc(T('w.stashSection')) + '</span></div>';
    mh += '<div class="crow"><span class="cmsg">' + esc(s.message || ref) + '</span></div>';
    if (s.date) {
        mh += '<div class="crow"><span class="cmeta">' + esc(fmtRelativeTime(s.date)) + '</span></div>';
    }
    mh += '</div>';
    info.innerHTML = mh;

    if (s.error) {
        filesBox.innerHTML = '<div class="empty">' + esc(T('stash.detailFailed', { error: s.error })) + '</div>';
        return;
    }
    if (!s.files) {
        filesBox.innerHTML = '<div class="empty">' + T('common.loadingFiles') + '</div>';
        return;
    }
    if (s.files.length === 0) {
        filesBox.innerHTML = '<div class="empty">' + T('stash.detailEmpty') + '</div>';
        return;
    }
    var mode = state.fileViewMode || FILE_MODE_TREE;
    var fh = fileHeadHtml(s.files.length, mode);
    fh += buildFileRows(s.files, mode, state.collapsed, detailFileRowHtml);
    filesBox.innerHTML = '<div id="d-files-inner">' + fh + '</div>';
    applyFileCursor();
}

/**
 * Show a stash's files without applying it. The host renumbers the stack after a
 * drop, so the message and date travel with the index: a row that no longer
 * matches is a different stash and must not keep the old file list on screen.
 */
function selectStash(index) {
    var entry = null;
    for (var i = 0; i < state.stashes.length; i++) {
        if (state.stashes[i].index === index) {entry = state.stashes[i]; break;}
    }
    clearPreview();
    state.stashDetail = {
        index: index,
        message: entry ? entry.message : '',
        date: entry ? entry.date : '',
        files: null
    };
    state.selectedHash = null;
    state.selectedHashes = [];
    state.lastClickedIndex = -1;
    state.multiCommits = null;
    state.multiFiles = null;
    state.detail = null;
    state.fileCursor = '';
    state.detailVisible = true;
    applyRowSelection();
    renderTree();
    renderDetail();
    saveViewState();
    vscode.postMessage({ command: 'selectStash', index: index });
}

function renderDetail() {
    applyDetailVisibility();
    document.getElementById('repo-name').textContent = state.repoName;
    var info = document.getElementById('d-info');
    var filesBox = document.getElementById('d-files');
    
    // A stash is not a commit in the log, so it replaces the detail pane instead
    // of trying to fit into the selected-commits model.
    if (state.stashDetail) {
        renderStashDetail(info, filesBox);
        return;
    }
    
    // Multi-select mode (2+ commits): show merged details
    if (state.selectedHashes.length > 1 && state.multiCommits) {
        renderMultiCommitDetail(info, filesBox);
        return;
    }
    
    // Single select with multiCommits data: use first commit
    if (state.selectedHashes.length === 1 && state.multiCommits && state.multiCommits.length > 0) {
        // Convert single commit from multiCommits to detail format
        var singleCommit = state.multiCommits[0];
        var singleFiles = state.multiFiles || [];
        state.detail = { commit: singleCommit, files: singleFiles };
        // Fall through to normal render
    }
    
    if (!state.detail) {
        info.innerHTML = '';
        filesBox.innerHTML = '<div class="empty">' + T('w.clickForDetail') + '</div>';
        return;
    }
    var c = state.detail.commit;
    var files = state.detail.files || [];

    // Build tooltip with all available info
    var tip = esc(c.message) + '\n' + esc(c.author || '') + ' <' + esc(c.authorEmail || '') + '>\n' + esc(fmtDate(c.authorDate || c.date));
    if (c.committer && c.committer !== c.author) {
        tip += '\n' + T('w.committerPrefix') + esc(c.committer) + ' <' + esc(c.committerEmail || '') + '> · ' + esc(fmtDate(c.committerDate || c.date));
    }
    
    var mh = '<div class="ccard" data-title="' + tip + '">';
    mh += '<div class="crow"><span class="hashchip">' + esc(c.shortHash) + '</span></div>';
    mh += '<div class="crow"><span class="cmsg">' + esc(c.message) + '</span></div>';
    mh += '<div class="crow"><span class="avatar" style="background:' + avatarColor(c.author || '?') + '">' + esc((c.author || '?').charAt(0).toUpperCase()) + '</span>' +
         '<span class="cmeta">' + esc(c.author) + ' &lt;' + esc(c.authorEmail) + '&gt; · ' + esc(fmtRelativeTime(c.authorDate || c.date)) + '</span></div>';
    
    // Show committer info if different from author (cherry-pick, rebase, merge scenarios)
    if (c.committer && c.committer !== c.author) {
        mh += '<div class="crow committer-row"><span class="committer-label">' + T('w.committerLabel') + '</span><span class="cmeta">' +
              esc(c.committer) + ' &lt;' + esc(c.committerEmail) + '&gt; · ' + esc(fmtRelativeTime(c.committerDate || c.date)) + '</span></div>';
    }
    
    mh += '</div>';
    info.innerHTML = mh;

    var mode = state.fileViewMode || FILE_MODE_TREE;
    var fh = fileHeadHtml(files.length, mode);
    fh += buildFileRows(files, mode, state.collapsed, detailFileRowHtml);

    filesBox.innerHTML = '<div id="d-files-inner">' + fh + '</div>';
    applyFileCursor();
}

/** One row of the detail panel's file list, in either display mode. */
function detailFileRowHtml(r) {
    var pad = fileRowPad(r.depth);
    if (r.kind === 'dir') {
        return '<div class="frow dir" data-path="' + esc(r.path) + '" style="' + pad + '"><span class="caret">' + (r.closed ? I_CARET_R : I_CARET_D) + '</span>' + (r.closed ? I_FOLDER : I_FOLDER_OPEN) + '<span class="fname" data-title="' + esc(r.path) + '">' + esc(r.name) + '</span><span class="fcount">' + r.count + '</span></div>';
    }
    var f = r.file;
    return '<div class="frow file" data-path="' + esc(f.path) + '" style="' + pad + '"><span class="caret"></span><span class="fi-wrap st-' + esc(f.status) + '">' + iconHtml(iconDefForFile(r.name), I_FILE) + '</span><span class="fname" data-title="' + esc(f.path) + '">' + esc(r.name) + '</span>' +
         '<span class="fstat"><span class="add">+' + (f.added || 0) + '</span> <span class="del">-' + (f.deleted || 0) + '</span> <span class="st-' + esc(f.status) + '">' + esc(f.status) + '</span></span></div>';
}

/* ---------- context menus ---------- */
function showMenu(x, y, items, onPick) {
    var existing = document.querySelector('.context-menu');
    if (existing) existing.remove();
    var menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.innerHTML = items.map(function (it) {
        return '<div class="context-menu-item" data-action="' + esc(it[0]) + '">' + esc(it[1]) + '</div>';
    }).join('');
    document.body.appendChild(menu);
    var vw = window.innerWidth, vh = window.innerHeight;
    var r = menu.getBoundingClientRect();
    if (x + r.width > vw) x = Math.max(4, vw - r.width - 4);
    if (y + r.height > vh) y = Math.max(4, vh - r.height - 4);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.querySelectorAll('.context-menu-item').forEach(function (item) {
        item.addEventListener('click', function () {
            onPick(item.getAttribute('data-action'));
            menu.remove();
        });
    });
    setTimeout(function () {
        document.addEventListener('click', function close() {
            menu.remove();
            document.removeEventListener('click', close);
        }, { once: true });
    }, 0);
}

/* ---------- date range filter (calendar popover, drag to circle a period) ---------- */
// Press the first day, drag to the last one, let go. Clicking works too: the first
// click is the start, the next one closes the range — which is how a period that
// needs a month navigation stays a single action instead of two typed endpoints.
var dateRange = { from: '', to: '' };
var datePick = { year: 0, month: 0, view: 'month', anchor: '', hover: '', dragging: false, pending: false };
var dateUi = null;

function pad2(n) { return n < 10 ? '0' + n : String(n); }
function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function todayYmd() { var d = new Date(); d.setHours(0, 0, 0, 0); return ymd(d); }
function dayShiftBack(days) {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - days);
    return ymd(d);
}

function syncDateTrigger() {
    var el = document.getElementById('dr-text');
    if (el) {
        if (dateRange.from || dateRange.to) {
            el.textContent = (dateRange.from || '…') + ' → ' + (dateRange.to || '…');
            el.className = 'dr-text';
        } else {
            el.textContent = T('ui.dateRange');
            el.className = 'dr-text placeholder';
        }
    }
    syncDateClr();
}

/** Endpoints are stored ordered, so "start after end" cannot happen by dragging. */
function applyDateRange(a, b) {
    var lo = a <= b ? a : b;
    var hi = a <= b ? b : a;
    dateRange.from = lo;
    dateRange.to = hi;
    datePick.dragging = false;
    datePick.pending = false;
    syncDateTrigger();
    pushFilters();
}

function clearDateRange() {
    dateRange.from = '';
    dateRange.to = '';
    datePick.dragging = false;
    datePick.pending = false;
    syncDateTrigger();
    if (dateUi && dateUi.isOpen) { renderDateGrid(); }
}

function buildDatePopover() {
    var pop = document.createElement('div');
    pop.className = 'date-popover';
    var weeks = T('date.weekdays').split(',').map(function (w) {
        return '<span>' + esc(w.trim()) + '</span>';
    }).join('');
    var chips = [
        [T('date.today'), 0],
        [T('date.last7Days'), 6],
        [T('date.last30Days'), 29],
        [T('date.last365Days'), 364]
    ].map(function (c) {
        return '<button class="dp-chip" type="button" data-days="' + c[1] + '">' + esc(c[0]) + '</button>';
    }).join('');
    pop.innerHTML =
        '<div class="dp-head">' +
        '<button class="dp-nav" type="button" data-nav="-1">&#8249;</button>' +
        '<button class="dp-title" type="button" data-act="switch"></button>' +
        '<button class="dp-nav" type="button" data-nav="1">&#8250;</button>' +
        '</div>' +
        '<div class="dp-week">' + weeks + '</div>' +
        '<div class="dp-grid"></div>' +
        '<div class="dp-chips">' + chips + '</div>' +
        '<div class="dp-foot"><span class="dp-hint"></span>' +
        '<button class="dp-clear" type="button" data-act="clear">' + esc(T('ui.clear')) + '</button></div>';
    document.body.appendChild(pop);
    return pop;
}

function datePreviewBounds() {
    if (datePick.dragging || datePick.pending) {
        var a = datePick.anchor;
        var b = datePick.hover || datePick.anchor;
        return [a <= b ? a : b, a <= b ? b : a];
    }
    return [dateRange.from, dateRange.to];
}

/**
 * Rebuild the cells only when the displayed month/year or the view changes, and
 * paint the selection by toggling classes in place. Re-rendering on every move
 * would detach the cell under the button, and the outside-click guard then reads
 * the press as "clicked nothing in here" and closes the popover mid-drag.
 */
function renderDateGrid() {
    if (!dateUi) {return;}
    var pop = dateUi.pop;
    var grid = pop.querySelector('.dp-grid');
    var isYear = datePick.view === 'year';
    var key = datePick.view + ':' + datePick.year + ':' + datePick.month;
    if (grid.getAttribute('data-key') !== key) {
        buildDateCells(grid, isYear);
        grid.setAttribute('data-key', key);
    }
    pop.querySelectorAll('.dp-nav').forEach(function (nav) {
        var back = nav.getAttribute('data-nav') === '-1';
        nav.setAttribute('data-title', T(isYear ? (back ? 'date.prevYear' : 'date.nextYear') : (back ? 'date.prevMonth' : 'date.nextMonth')));
    });
    pop.querySelector('.dp-title').textContent = isYear
        ? T('date.yearTitle', { y: datePick.year })
        : T('date.monthTitle', { y: datePick.year, m: datePick.month + 1 });
    var bounds = datePreviewBounds();
    if (isYear) {
        pop.querySelectorAll('.dp-month').forEach(function (cell) {
            cell.classList.toggle('sel', Number(cell.getAttribute('data-month')) === datePick.month);
        });
    } else {
        pop.querySelectorAll('.dp-day').forEach(function (cell) {
            var iso = cell.getAttribute('data-date');
            var end = !!bounds[0] && (iso === bounds[0] || iso === bounds[1]);
            cell.classList.toggle('sel', end);
            cell.classList.toggle('mid', !end && !!bounds[0] && !!bounds[1] && iso > bounds[0] && iso < bounds[1]);
        });
    }
    pop.querySelector('.dp-hint').textContent = T(datePick.pending ? 'date.pickEndHint' : 'date.dragHint');
}

function buildDateCells(grid, isYear) {
    grid.className = isYear ? 'dp-grid dp-months' : 'dp-grid';
    if (isYear) {
        var months = T('date.months').split(',');
        var cells = '';
        for (var i = 0; i < 12; i++) {
            cells += '<div class="dp-cell dp-month" data-month="' + i + '">' + esc((months[i] || '').trim()) + '</div>';
        }
        grid.innerHTML = cells;
        return;
    }
    // Monday-first grid, six weeks so the popover never changes height mid-drag.
    var lead = (new Date(datePick.year, datePick.month, 1).getDay() + 6) % 7;
    var start = new Date(datePick.year, datePick.month, 1 - lead);
    var today = todayYmd();
    var days = '';
    for (var d = 0; d < 42; d++) {
        var day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + d);
        var cls = 'dp-cell dp-day';
        if (day.getMonth() !== datePick.month) { cls += ' out'; }
        if (ymd(day) === today) { cls += ' today'; }
        days += '<div class="' + cls + '" data-date="' + ymd(day) + '">' + day.getDate() + '</div>';
    }
    grid.innerHTML = days;
}

function openDatePicker() {
    if (!dateUi) {return;}
    var box = document.getElementById('date-range');
    var focusStr = dateRange.to || dateRange.from || todayYmd();
    var parts = focusStr.split('-');
    datePick.year = Number(parts[0]);
    datePick.month = Number(parts[1]) - 1;
    datePick.view = 'month';
    datePick.dragging = false;
    datePick.pending = false;
    datePick.hover = '';
    dateUi.isOpen = true;
    dateUi.pop.classList.add('open');
    if (box) { box.classList.add('open'); }
    renderDateGrid();
    var r = box.getBoundingClientRect();
    dateUi.pop.style.left = '0px';
    dateUi.pop.style.top = '0px';
    var pr = dateUi.pop.getBoundingClientRect();
    var left = Math.max(4, r.left);
    var top = r.bottom + 6;
    if (top + pr.height > window.innerHeight - 6) { top = Math.max(6, r.top - pr.height - 6); }
    dateUi.pop.style.left = left + 'px';
    dateUi.pop.style.top = top + 'px';
    // The host webview can be zoomed (window zoom / `window.zoomLevel`), and under
    // a zoom a CSS px and a rect px are different scales, so the clamp above is
    // only an estimate: nudge against the rect that was actually rendered.
    for (var i = 0; i < 2; i++) {
        var got = dateUi.pop.getBoundingClientRect();
        var dx = got.right > window.innerWidth - 4 ? got.right - window.innerWidth + 4 : 0;
        var dy = got.bottom > window.innerHeight - 4 ? got.bottom - window.innerHeight + 4 : 0;
        if (!dx && !dy) {break;}
        dateUi.pop.style.left = (parseFloat(dateUi.pop.style.left) - dx) + 'px';
        dateUi.pop.style.top = (parseFloat(dateUi.pop.style.top) - dy) + 'px';
    }
    if (window._hideTooltip) window._hideTooltip();
}

function closeDatePicker() {
    if (!dateUi) {return;}
    dateUi.isOpen = false;
    dateUi.pop.classList.remove('open');
    var box = document.getElementById('date-range');
    if (box) { box.classList.remove('open'); }
    datePick.dragging = false;
    datePick.pending = false;
}

function initDateRange() {
    var trigger = document.getElementById('date-trigger');
    var box = document.getElementById('date-range');
    if (!trigger || !box) {return;}
    var pop = buildDatePopover();
    dateUi = { pop: pop, isOpen: false };

    trigger.addEventListener('click', function () {
        if (dateUi.isOpen) { closeDatePicker(); } else { openDatePicker(); }
    });

    pop.addEventListener('click', function (e) {
        var nav = e.target.closest('.dp-nav');
        if (nav) {
            var step = Number(nav.getAttribute('data-nav'));
            if (datePick.view === 'year') {
                datePick.year += step;
            } else {
                datePick.month += step;
                if (datePick.month < 0) { datePick.month = 11; datePick.year--; }
                if (datePick.month > 11) { datePick.month = 0; datePick.year++; }
            }
            renderDateGrid();
            return;
        }
        if (e.target.closest('[data-act="switch"]')) {
            datePick.view = datePick.view === 'month' ? 'year' : 'month';
            renderDateGrid();
            return;
        }
        if (e.target.closest('[data-act="clear"]')) {
            clearDateRange();
            closeDatePicker();
            pushFilters();
            return;
        }
        var chip = e.target.closest('.dp-chip');
        if (chip) {
            applyDateRange(dayShiftBack(Number(chip.getAttribute('data-days'))), todayYmd());
            closeDatePicker();
            return;
        }
        var month = e.target.closest('.dp-month');
        if (month) {
            datePick.month = Number(month.getAttribute('data-month'));
            datePick.view = 'month';
            renderDateGrid();
        }
    });

    pop.addEventListener('mousedown', function (e) {
        var day = e.target.closest('.dp-day');
        if (!day) {return;}
        // Without this the drag starts a text selection over the grid.
        e.preventDefault();
        var iso = day.getAttribute('data-date');
        if (datePick.pending) {
            applyDateRange(datePick.anchor, iso);
            closeDatePicker();
            return;
        }
        datePick.dragging = true;
        datePick.anchor = iso;
        datePick.hover = iso;
        renderDateGrid();
    });

    pop.addEventListener('mousemove', function (e) {
        if (!datePick.dragging && !datePick.pending) {return;}
        var day = e.target.closest('.dp-day');
        if (!day) {return;}
        var iso = day.getAttribute('data-date');
        if (iso === datePick.hover) {return;}
        datePick.hover = iso;
        renderDateGrid();
    });

    document.addEventListener('mouseup', function (e) {
        if (!datePick.dragging) {return;}
        // Only a release inside the calendar ends the drag. A press abandoned
        // outside (released over another panel or outside the window) leaves this
        // handler without a matching mouseup, so the next unrelated click would
        // otherwise commit a range the user never finished circling.
        if (!pop.contains(e.target)) {
            datePick.dragging = false;
            renderDateGrid();
            return;
        }
        datePick.dragging = false;
        if (datePick.hover !== datePick.anchor) {
            applyDateRange(datePick.anchor, datePick.hover);
            closeDatePicker();
        } else {
            datePick.pending = true;
            renderDateGrid();
        }
    });

    document.addEventListener('mousedown', function (e) {
        if (!dateUi.isOpen) {return;}
        if (pop.contains(e.target) || box.contains(e.target)) {return;}
        closeDatePicker();
    });

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && dateUi.isOpen) { closeDatePicker(); }
    });

    syncDateTrigger();
}

/* ---------- events ---------- */
function pushFilters() {
    // Convert date format to include time for better git filtering
    // YYYY-MM-DD -> YYYY-MM-DDT00:00:00 (start of day)
    // YYYY-MM-DD -> YYYY-MM-DDT23:59:59 (end of day)
    var fromFormatted = dateRange.from ? dateRange.from + 'T00:00:00' : '';
    var toFormatted = dateRange.to ? dateRange.to + 'T23:59:59' : '';

    vscode.postMessage({
        command: 'setFilters',
        text: document.getElementById('f-search').value,
        author: document.getElementById('f-author').value,
        path: document.getElementById('f-path').value,
        from: fromFormatted,
        to: toFormatted
    });
}
var debounce;
document.getElementById('f-search').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
        pushFilters();
    }
});
document.getElementById('f-path').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
        // Same rule as the other filter boxes: search on Enter, not per keystroke.
        pushFilters();
    }
});
document.getElementById('f-author').addEventListener('input', function (e) {
    filterAuthors(e.target.value);
    // Don't auto-search on input, only on Enter key or dropdown selection
});
document.getElementById('f-author').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
        pushFilters();
    } else {
        handleAuthorKeydown(e);
    }
});
document.getElementById('f-author').addEventListener('blur', function() {
    // Close dropdown after a short delay to allow click events
    setTimeout(closeAuthorDropdown, 200);
});

// Date range: one control in the bar, one calendar in a popover. A period is a
// gesture here — press the first day, drag to the last, let go — instead of two
// endpoints typed into native date fields, whose calendar popup the theme cannot
// reach (same reason the author box got its own dropdown).
initDateRange();
document.getElementById('btn-refresh').addEventListener('click', function () {
    vscode.postMessage({ command: 'refresh' });
});
document.getElementById('btn-reflog').addEventListener('click', function () {
    // Same branch as the commit list above: the reflog answers "what moved
    // this branch", not "what moved HEAD". With nothing selected the host
    // falls back to the checked-out branch.
    vscode.postMessage({ command: 'action', action: 'reflog', branch: state.selectedBranch || '' });
});
document.getElementById('tg-graph').addEventListener('click', function () {
    state.graphVisible = state.graphVisible === false;
    renderRows();
    saveViewState();
});
document.getElementById('f-bfilter').addEventListener('input', function (e) {
    state.bfilter = e.target.value.trim();
    renderTree();
});

function syncClr(inputId, clrId) {
    var i = document.getElementById(inputId);
    var b = document.getElementById(clrId);
    if (i && b) b.style.display = i.value ? '' : 'none';
}
['f-search|clr-search', 'f-author|clr-author', 'f-path|clr-path', 'f-bfilter|clr-bfilter'].forEach(function (pair) {
    var ids = pair.split('|');
    syncClr(ids[0], ids[1]);
    var i = document.getElementById(ids[0]);
    if (i) i.addEventListener('input', function () { syncClr(ids[0], ids[1]); });
});
function syncDateClr() {
    var on = !!(dateRange.from || dateRange.to);
    var b = document.getElementById('clr-date');
    if (b) b.style.display = on ? '' : 'none';
}

document.getElementById('clr-search').addEventListener('click', function () {
    document.getElementById('f-search').value = '';
    syncClr('f-search', 'clr-search'); pushFilters();
});
document.getElementById('clr-author').addEventListener('click', function () {
    document.getElementById('f-author').value = '';
    syncClr('f-author', 'clr-author'); pushFilters();
});
document.getElementById('clr-path').addEventListener('click', function () {
    document.getElementById('f-path').value = '';
    syncClr('f-path', 'clr-path'); pushFilters();
});
document.getElementById('clr-date').addEventListener('click', function () {
    clearDateRange(); pushFilters();
});
document.getElementById('clr-bfilter').addEventListener('click', function () {
    document.getElementById('f-bfilter').value = '';
    state.bfilter = ''; renderTree(); syncClr('f-bfilter', 'clr-bfilter');
});

/* ---------- infinite scroll ---------- */
function setLoader(on) {
    state.loadingMore = on;
    document.getElementById('loader').className = on ? 'on' : '';
}

/* ---------- delayed busy overlays (only show for slow operations) ---------- */
var busyTimers = {};

/* ---------- initial loading skeleton ---------- */
function renderCommitSkeleton(count) {
    var html = '<div class="commit-skeleton">';
    for (var i = 0; i < count; i++) {
        html += '<div class="commit-skeleton-row">' +
            '<div class="skeleton commit-graph-line"></div>' +
            '<div class="skeleton commit-message-line"></div>' +
            '<div class="skeleton commit-author-line"></div>' +
            '</div>';
    }
    html += '</div>';
    return html;
}

function renderBranchSkeleton() {
    var html = '<div class="branch-skeleton">';
    for (var i = 0; i < 8; i++) {
        html += '<div class="branch-skeleton-item">' +
            '<div class="skeleton branch-skeleton-icon"></div>' +
            '<div class="skeleton branch-skeleton-label ' + (i % 3 === 0 ? 'short' : i % 3 === 1 ? 'medium' : 'long') + '"></div>' +
            '</div>';
    }
    html += '</div>';
    return html;
}

function showInitialLoading() {
    loadState.startTime = Date.now();
    // Show skeleton in branches tree
    var btree = document.getElementById('btree');
    if (btree && !loadState.branchesLoaded) {
        btree.innerHTML = renderBranchSkeleton();
    }
}

function hideInitialLoading() {
    var elapsed = Date.now() - loadState.startTime;
    // Ensure minimum display time for smooth animation (300ms)
    var remaining = Math.max(0, 300 - elapsed);
    setTimeout(function() {
        // Add content-loaded animation class to main areas
        var rows = document.getElementById('rows');
        if (rows) rows.classList.add('content-loaded');
        
        var btree = document.getElementById('btree');
        if (btree) btree.classList.add('content-loaded');
    }, remaining);
}

function setBusy(area, on) {
    // multiCommits uses its own inline loading state in detail panel, don't show rows-busy
    if (area === 'multiCommits') return;
    
    var el = document.getElementById(area === 'detail' ? 'd-busy' : 'rows-busy');
    if (!el) return;
    if (busyTimers[area]) { clearTimeout(busyTimers[area]); busyTimers[area] = null; }
    if (on) {
        busyTimers[area] = setTimeout(function () { el.className = 'busy on'; }, 300);
    } else {
        el.className = 'busy';
    }
}
document.getElementById('scroll').addEventListener('scroll', function () {
    saveViewState();
    if (!state.hasMore || state.loadingMore) return;
    var el = document.getElementById('scroll');
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 30) {
        setLoader(true);
        vscode.postMessage({ command: 'loadMore' });
    }
});

// Click handler for folders/sections (expand/collapse) and HEAD section
document.getElementById('btree').addEventListener('click', function (e) {
    var stashRow = e.target.closest('.sitem');
    if (stashRow) {
        selectStash(parseInt(stashRow.getAttribute('data-stash'), 10));
        return;
    }
    var sec = e.target.closest('.bsec');
    if (sec) {
        var key = sec.getAttribute('data-sec');
        if (state.collapsedSec[key]) delete state.collapsedSec[key]; else state.collapsedSec[key] = true;
        renderTree();
        saveViewState();
        return;
    }
    var fol = e.target.closest('.bfolder');
    if (fol) {
        var fp = fol.getAttribute('data-folder');
        if (state.expandedFolder[fp]) delete state.expandedFolder[fp]; else state.expandedFolder[fp] = true;
        renderTree();
        saveViewState();
        return;
    }
    // Cherry-pick resume button
    var resumeBtn = e.target.closest('.cherry-pick-resume');
    if (resumeBtn && state.cherryPickResume) {
        vscode.postMessage({ 
            command: 'action', 
            action: 'resumeCherryPick',
            remainingHashes: state.cherryPickResume.remainingHashes
        });
        return;
    }
});

// Double-click handler for branch items only (switch branch)
document.getElementById('btree').addEventListener('dblclick', function (e) {
    var worktree = e.target.closest('.witem');
    if (worktree) {
        // The worktree this window already shows has nowhere to go.
        if (worktree.classList.contains('cur')) {return;}
        e.preventDefault();
        vscode.postMessage({
            command: 'action',
            action: 'worktreeOpen',
            worktreePath: worktree.getAttribute('data-worktree')
        });
        return;
    }
    var item = e.target.closest('.bitem');
    if (!item) return;
    var name = item.getAttribute('data-branch');
    state.selectedBranch = name;
    state.highlight = name;
    state.detail = null;
    state.stashDetail = null;
    clearPreview();
    renderTree();
    renderDetail();
    saveViewState();
    vscode.postMessage({ command: 'selectBranch', branch: name });
});

document.getElementById('rf-branch').addEventListener('click', function () {
    vscode.postMessage({ command: 'refreshBranches' });
});

document.getElementById('fav-filter').addEventListener('click', function () {
    state.favoritesOnly = !state.favoritesOnly;
    renderTree();
});

/**
 * The toolbar star is also the filter's indicator: accent-filled while it is
 * narrowing the tree, dimmed while nothing is marked yet. renderTree keeps it in
 * step with whatever branch list it just drew.
 */
function syncFavFilterBtn() {
    var btn = document.getElementById('fav-filter');
    if (!btn) {return;}
    btn.classList.toggle('on', !!state.favoritesOnly);
    btn.classList.toggle('off', !state.favoritesOnly && state.favorites.length === 0);
}

document.getElementById('stash-save').addEventListener('click', function () {
    vscode.postMessage({ command: 'action', action: 'stashSave' });
});

document.getElementById('tg-files').addEventListener('click', function () {
    state.detailVisible = !state.detailVisible;
    applyDetailVisibility();
    saveViewState();
});

document.getElementById('rf-files').addEventListener('click', function () {
    if (state.stashDetail) {
        selectStash(state.stashDetail.index);
        return;
    }
    if (state.selectedHash) {
        vscode.postMessage({ command: 'refreshFiles', hash: state.selectedHash });
    }
});

document.getElementById('btree').addEventListener('contextmenu', function (e) {
    var worktreeRow = e.target.closest('.witem');
    if (worktreeRow) {
        // This window already shows that worktree, so it has no actions — but the
        // click still must not fall through to the native context menu.
        if (worktreeRow.classList.contains('cur')) {
            e.preventDefault();
            return;
        }
        e.preventDefault();
        if (window._hideTooltip) window._hideTooltip();

        var worktreePath = worktreeRow.getAttribute('data-worktree');
        // Git refuses to remove the main worktree, so that row only offers to open.
        var worktreeMenu = [['worktreeOpen', T('menu.worktreeOpen')]];
        if (!worktreeRow.classList.contains('main')) {
            worktreeMenu.push(['worktreeRemove', T('menu.worktreeRemove')]);
        }
        showMenu(e.clientX, e.clientY, worktreeMenu, function (action) {
            vscode.postMessage({ command: 'action', action: action, worktreePath: worktreePath });
        });
        return;
    }

    var stashRow = e.target.closest('.sitem');
    if (stashRow) {
        e.preventDefault();
        if (window._hideTooltip) window._hideTooltip();

        var stashIndex = parseInt(stashRow.getAttribute('data-stash'), 10);
        showMenu(e.clientX, e.clientY, [
            ['stashApply', T('menu.stashApply')],
            ['stashPop', T('menu.stashPop')],
            ['stashDrop', T('menu.stashDrop')]
        ], function (action) {
            vscode.postMessage({ command: 'action', action: action, stash: stashIndex });
        });
        return;
    }

    var item = e.target.closest('.bitem');
    if (!item) return;
    e.preventDefault();
    
    // Hide any visible tooltip when showing context menu
    if (window._hideTooltip) window._hideTooltip();
    
    var branch = item.getAttribute('data-branch');
    
    var isRemote = state.remote.indexOf(branch) >= 0;
    var isCurrent = branch === state.current;
    var isFavorite = state.favorites.indexOf(branch) >= 0;
    
    var menuItems;
    if (isRemote) {
        menuItems = [
            ['checkout', T('menu.checkout')],
            ['fetch', T('menu.fetchRemote')],
            ['newBranchFrom', T('menu.newBranchFrom')],
            ['compareBranch', T('menu.compareWithCurrent')]
        ];
    } else if (isCurrent) {
        // Current branch: only show applicable actions
        menuItems = [
            ['update', T('menu.pull')],
            ['push', T('menu.push')],
            ['newBranchFrom', T('menu.newBranchFrom')],
            ['rename', T('menu.rename')],
            ['openRemoteBranch', T('menu.openOnRemote')]
        ];
    } else {
        // Other local branches: full action set
        menuItems = [
            ['checkout', T('menu.checkout')],
            ['update', T('menu.pull')],
            ['push', T('menu.push')],
            ['merge', T('menu.merge')],
            ['rebase', T('menu.rebase')],
            ['newBranchFrom', T('menu.newBranchFrom')],
            ['worktreeAdd', T('menu.worktreeAdd')],
            ['compareBranch', T('menu.compareWithCurrent')],
            ['rename', T('menu.rename')],
            ['deleteBranch', T('menu.deleteBranch')],
            ['openRemoteBranch', T('menu.openOnRemote')]
        ];
    }

    // Marking a branch is the one action every kind of row offers, so the
    // type-specific list keeps its order on top and the star sits below it.
    showMenu(e.clientX, e.clientY, menuItems.concat([['toggleFavorite', T(isFavorite ? 'menu.unfavorite' : 'menu.favorite')]]), function (action) {
        vscode.postMessage({ command: 'action', action: action, branch: branch });
    });
});

document.getElementById('rows').addEventListener('click', function (e) {
    var row = e.target.closest('.row');
    if (!row) return;
    
    var hash = row.getAttribute('data-hash');
    var allRows = Array.from(document.querySelectorAll('#rows .row'));
    var currentIndex = allRows.indexOf(row);
    
    // Multi-select with Ctrl/Cmd or Shift
    if (e.ctrlKey || e.metaKey) {
        // Ctrl/Cmd + click: toggle single selection
        var idx = state.selectedHashes.indexOf(hash);
        if (idx >= 0) {
            state.selectedHashes.splice(idx, 1);
        } else {
            state.selectedHashes.push(hash);
        }
        state.lastClickedIndex = currentIndex;
    } else if (e.shiftKey && state.lastClickedIndex >= 0) {
        // Shift + click: select range
        var start = Math.min(state.lastClickedIndex, currentIndex);
        var end = Math.max(state.lastClickedIndex, currentIndex);
        state.selectedHashes = [];
        for (var i = start; i <= end; i++) {
            var h = allRows[i].getAttribute('data-hash');
            if (h) state.selectedHashes.push(h);
        }
    } else {
        // Single click: clear and select one
        state.selectedHashes = [hash];
        state.lastClickedIndex = currentIndex;
    }
    
    // Update selectedHash for backward compatibility
    state.selectedHash = state.selectedHashes.length > 0 ? state.selectedHashes[state.selectedHashes.length - 1] : null;
    state.fileCursor = '';

    // Update UI
    applyRowSelection();
    loadSelectedDetail();
});

document.getElementById('rows').addEventListener('contextmenu', function (e) {
    var row = e.target.closest('.row');
    if (!row) return;
    e.preventDefault();
    
    // Hide any visible tooltip when showing context menu
    if (window._hideTooltip) window._hideTooltip();
    
    var hash = row.getAttribute('data-hash');
    var isMultiSelect = state.selectedHashes.length > 1;
    
    // If the clicked commit is not in the current selection, clear selection and select only this one
    if (state.selectedHashes.indexOf(hash) < 0) {
        state.selectedHashes = [hash];
        state.selectedHash = hash;
        state.lastClickedIndex = Array.from(document.querySelectorAll('#rows .row')).indexOf(row);
        applyRowSelection();
        isMultiSelect = false;
    }
    
    var isHead = !!state.headHash && hash === state.headHash;
    var items = [];
    
    if (isMultiSelect) {
        // Multi-select mode: allow cherry-pick, revert, drop, and squash
        items = [
            ['cherryPick', T('menu.cherryPick') + ' (' + state.selectedHashes.length + ')'],
            ['revert', T('menu.revert') + ' (' + state.selectedHashes.length + ')'],
            ['dropCommit', T('menu.dropCommit') + ' (' + state.selectedHashes.length + ')'],
            ['squashCommits', T('menu.squashCommits') + ' (' + state.selectedHashes.length + ')']
        ];
    } else {
        // Single-select mode: show all options
        items = [
            ['showDiff', T('menu.showDiff')],
            ['cherryPick', T('menu.cherryPick')],
            ['revert', T('menu.revert')],
            ['reset', T('menu.reset')]
        ];
        if (isHead) {
            items.push(['editMessage', T('menu.editMessage')]);
            items.push(['amend', T('menu.amend')]);
            items.push(['dropCommit', T('menu.dropCommit')]);
        }
        items.push(['newBranchFrom', T('menu.newBranchFrom')]);
        items.push(['newTag', T('menu.newTag')]);

        // The host knows which refs are tags, so only offer to manage the ones
        // actually sitting on this commit.
        var rowCommit = (state.commits || []).find(function (x) { return x.hash === hash; });
        var rowTags = (rowCommit && rowCommit.tags) || [];
        if (rowTags.length > 0) {
            items.push(['pushTag', T('menu.pushTag') + ' (' + rowTags.length + ')']);
            items.push(['deleteTag', T('menu.deleteTag') + ' (' + rowTags.length + ')']);
        }
    }
    items.push(['openRemoteCommit', T('menu.openOnRemote')]);
    items.push(['copy', T('menu.copyHash')]);

    showMenu(e.clientX, e.clientY, items, function (action) {
        if (action === 'copy' || action === 'copyMessage') {
            var hashes = state.selectedHashes.length > 1 ? state.selectedHashes : [hash];
            navigator.clipboard.writeText(action === 'copy'
                ? hashes.join('\n')
                : hashes.map(function (h) {
                    var c = (state.commits || []).find(function (x) { return x.hash === h; });
                    return (c ? c.shortHash + ' ' + (c.message || '') : h);
                }).join('\n'));
            return;
        }
        vscode.postMessage({ 
            command: 'action', 
            action: action, 
            hash: hash,
            hashes: state.selectedHashes.length > 1 ? state.selectedHashes : undefined
        });
    });
});

document.getElementById('d-files').addEventListener('click', function (e) {
    var btn = e.target.closest('.fmode-btn');
    if (btn) {
        state.fileViewMode = btn.getAttribute('data-fmode');
        renderDetail();
        saveViewState();
        return;
    }
    var dir = e.target.closest('.frow.dir');
    if (dir) {
        var p = dir.getAttribute('data-path');
        if (state.collapsed[p]) delete state.collapsed[p]; else state.collapsed[p] = true;
        renderDetail();
        saveViewState();
        return;
    }
    // A single click pins the keyboard cursor; double-click opens the real
    // two-column diff in the editor. Only stash files preview inline on this
    // branch — commit files keep the editor as their diff surface.
    var file = e.target.closest('.frow.file');
    if (file) {
        state.fileCursor = file.getAttribute('data-path');
        applyFileCursor();
        if (state.stashDetail) {requestFilePreview(state.fileCursor);}
    }
});

// Double-click a file in the detail panel to open its commit diff (was single-click)
document.getElementById('d-files').addEventListener('dblclick', function (e) {
    var file = e.target.closest('.frow.file');
    if (!file) {return;}
    var path = file.getAttribute('data-path');
    if (state.stashDetail) {
        vscode.postMessage({ command: 'action', action: 'fileDiff', stash: state.stashDetail.index, path: path });
        return;
    }
    if (state.selectedHash) {
        // With a group selected the host opens one patch document per commit, so it
        // needs every hash, not just the last-clicked one.
        vscode.postMessage({
            command: 'action',
            action: 'fileDiff',
            hash: state.selectedHash,
            hashes: state.selectedHashes,
            path: path
        });
    }
});

// Right-click a file in the detail panel: compare against local working tree / cherry-pick the file
document.getElementById('d-files').addEventListener('contextmenu', function (e) {
    var file = e.target.closest('.frow.file');
    if (!file || !state.selectedHash) { return; }
    e.preventDefault();
    if (window._hideTooltip) window._hideTooltip();
    var path = file.getAttribute('data-path');
    var items = [];
    // "Source" is the version the selected commit left behind; with a group
    // selected there is no single such version, so the item stays single-only.
    if (state.selectedHashes.length <= 1) {
        items.push(['fileJumpToSource', T('menu.fileJumpToSource')]);
    }
    items.push(
        ['fileCompareLocal', T('menu.fileCompareLocal')],
        ['fileCherryPick', T('menu.fileCherryPick')],
        ['filterPath', T('menu.filterByPath')]
    );
    showMenu(e.clientX, e.clientY, items, function (action) {
        if (action === 'filterPath') {
            // Purely local: fill the toolbar path box and re-query. Keeping it here
            // avoids a host round-trip just to echo a filter the panel already owns.
            document.getElementById('f-path').value = path;
            syncClr('f-path', 'clr-path');
            pushFilters();
            return;
        }
        vscode.postMessage({ command: 'action', action: action, hash: state.selectedHash, path: path });
    });
});

/* ---------- inline diff preview ---------- */

/*
 * One file's diff, drawn under the file list, so reading a change does not always
 * cost an editor tab. The host classifies every line before sending it — the pane
 * paints what it is handed and never parses a patch itself.
 */
function clearPreview() {
    state.preview = null;
    renderPreview();
}

function requestFilePreview(path) {
    var stash = state.stashDetail ? state.stashDetail.index : undefined;
    if ((!state.selectedHash && stash === undefined) || !path) {return;}
    var hashes = state.selectedHashes.length > 1 ? state.selectedHashes : undefined;
    // One key names the side the file list belongs to. It is a string because the
    // commit side has no hash while a stash is shown, and undefined/null would
    // otherwise have to compare equal across the two kinds of answer.
    var key = stash === undefined ? 'commit:' + state.selectedHash : 'stash:' + stash;
    state.preview = { path: path, key: key, loading: true };
    renderPreview();
    vscode.postMessage({ command: 'filePreview', path: path, hash: state.selectedHash || undefined, hashes: hashes, stash: stash });
}

function diffLineHtml(line) {
    return '<div class="dl ' + esc(line.kind || 'context') + '">' +
        '<span class="dn">' + (line.old === undefined ? '' : line.old) + '</span>' +
        '<span class="dn">' + (line.next === undefined ? '' : line.next) + '</span>' +
        '<span class="dt">' + esc(line.text || '') + '</span></div>';
}

function renderPreview() {
    var box = document.getElementById('d-preview');
    var resizer = document.getElementById('resizer-preview');
    var body = document.getElementById('dp-body');
    var p = state.preview;
    if (!p) {
        box.style.display = 'none';
        if (resizer) {resizer.style.display = 'none';}
        body.innerHTML = '';
        document.getElementById('dp-path').textContent = '';
        return;
    }
    box.style.display = 'flex';
    if (resizer) {resizer.style.display = 'block';}
    document.getElementById('dp-path').textContent = p.path;
    if (p.loading) {
        body.innerHTML = '<div class="dp-note">' + esc(T('preview.loading')) + '</div>';
        return;
    }
    // Binary/error answers already say everything worth saying; repeating git's
    // own "Binary files … differ" header under the note adds nothing.
    var lines = (p.binary || p.error) ? [] : (p.lines || []);
    var html = '';
    if (p.error) {
        html += '<div class="dp-note err">' + esc(T('preview.failed', { error: p.error })) + '</div>';
    } else if (p.binary) {
        html += '<div class="dp-note">' + esc(T('preview.binary')) + '</div>';
    } else if (p.empty) {
        html += '<div class="dp-note">' + esc(T('preview.empty')) + '</div>';
    }
    html += lines.map(diffLineHtml).join('');
    if (p.truncated) {
        html += '<div class="dp-note">' + esc(T('preview.truncated', { n: lines.length })) + '</div>';
    }
    body.innerHTML = html;
    body.scrollTop = 0;
}

document.getElementById('dp-close').addEventListener('click', clearPreview);

document.getElementById('dp-editor').addEventListener('click', function () {
    var p = state.preview;
    if (!p || p.loading) {return;}
    var stash = state.stashDetail ? state.stashDetail.index : undefined;
    vscode.postMessage({
        command: 'action',
        action: 'fileDiff',
        hash: stash === undefined ? state.selectedHash : undefined,
        hashes: stash === undefined ? state.selectedHashes : undefined,
        stash: stash,
        path: p.path
    });
});

/* ---------- keyboard navigation ---------- */

/*
 * The three panes are focusable containers, so Tab walks branches -> commits ->
 * files instead of leaving the panel, and the arrow keys then act inside whichever
 * pane owns focus. Rows carry no tabindex of their own: a row per tab stop would
 * make reaching the next pane take as many presses as there are commits.
 */
var KEY_PANES = [
    { id: 'btree', name: 'branches' },
    { id: 'scroll', name: 'commits' },
    { id: 'd-files', name: 'files' }
];

function initPaneFocus() {
    KEY_PANES.forEach(function (p) {
        var el = document.getElementById(p.id);
        if (!el) {return;}
        el.tabIndex = 0;
        el.dataset.pane = p.name;
        // Chrome focuses a tabbable ancestor when a click lands on a plain child,
        // but the rows inside these panes are re-rendered constantly, so a mouse
        // press pins the focus here instead: the arrows have to belong to the pane
        // the user just clicked, not wherever the click happened to land.
        el.addEventListener('mousedown', function () {
            el.focus({ preventScroll: true });
        });
    });
}

function paneNameOf(el) {
    while (el) {
        if (el.dataset && el.dataset.pane) {return el.dataset.pane;}
        el = el.parentElement;
    }
    return '';
}

function isTypingTarget(el) {
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ||
        el.tagName === 'SELECT' || el.isContentEditable);
}

/** Which pane owns the arrow keys; '' while a text field does. */
function activeKeyPane() {
    var el = document.activeElement;
    if (!el || el === document.body) {return '';}
    if (isTypingTarget(el)) {return '';}
    return paneNameOf(el);
}

/** A dialog, menu or popover owns the keyboard: never move the selection under it. */
function uiOverlayIsOpen() {
    if (authorDropdownState.isOpen || repoMenu.open) {return true;}
    if (dateUi && dateUi.isOpen) {return true;}
    return !!document.querySelector('.context-menu, .dialog-overlay, .squash-dialog-overlay, .push-dialog-overlay');
}

function movePaneFocus(step) {
    var names = KEY_PANES.map(function (p) {return p.name;});
    var at = names.indexOf(activeKeyPane());
    var next = at < 0
        ? (step > 0 ? 0 : names.length - 1)
        : (at + step + names.length) % names.length;
    var el = document.getElementById(KEY_PANES[next].id);
    if (el) {el.focus();}
}

/* --- commit list --- */

function handleCommitKeys(e) {
    var rows = commitRowList();
    if (rows.length === 0) {return;}
    var at = commitCursorIndex(rows);
    var page = Math.max(3, Math.floor(document.getElementById('scroll').clientHeight /
        (rows[0].offsetHeight || 30)));
    var next;
    switch (e.key) {
        case 'ArrowDown': next = at + 1; break;
        case 'ArrowUp': next = at - 1; break;
        case 'Home': next = 0; break;
        case 'End': next = rows.length - 1; break;
        case 'PageDown': next = at + page; break;
        case 'PageUp': next = at - page; break;
        case 'Enter':
            if (state.selectedHash) {
                vscode.postMessage({
                    command: 'action',
                    action: 'showDiff',
                    hash: state.selectedHash,
                    hashes: state.selectedHashes.length > 1 ? state.selectedHashes : undefined
                });
            }
            e.preventDefault();
            return;
        default: return;
    }
    next = Math.max(0, Math.min(next, rows.length - 1));
    e.preventDefault();
    if (next !== at) {selectCommitIndex(next, e.shiftKey);}
}

function commitCursorIndex(rows) {
    for (var i = 0; i < rows.length; i++) {
        if (rows[i].getAttribute('data-hash') === state.selectedHash) {return i;}
    }
    // Nothing selected (or the selected commit scrolled out of the loaded page):
    // start from the anchor, or from the top of the list.
    return (state.lastClickedIndex >= 0 && state.lastClickedIndex < rows.length)
        ? state.lastClickedIndex : 0;
}

/* --- changed files list --- */

function fileRowList() {
    return Array.from(document.querySelectorAll('#d-files .frow'));
}

/** Re-mark the cursor row after the list was rebuilt (collapse, new selection). */
function applyFileCursor() {
    if (!state.fileCursor) {return;}
    fileRowList().forEach(function (row) {
        row.classList.toggle('kcur', row.getAttribute('data-path') === state.fileCursor);
    });
}

function selectFileRow(row) {
    state.fileCursor = row.getAttribute('data-path');
    applyFileCursor();
    row.scrollIntoView({ block: 'nearest' });
    // A stash's files preview as the cursor moves; a commit's files keep the
    // editor as their only diff surface on this branch.
    if (!isDirRow(row) && state.stashDetail) {requestFilePreview(state.fileCursor);}
}

function isDirRow(row) {
    return row.classList.contains('dir');
}

function dirRowIsOpen(row) {
    return !state.collapsed[row.getAttribute('data-path')];
}

/** Enter / Right on a file row: the same thing a double-click does. */
function openFileRow(row) {
    if (isDirRow(row)) {
        row.click();
        return;
    }
    if (!state.selectedHash && !state.stashDetail) {return;}
    // Reuse the dblclick handler instead of restating the diff message it sends —
    // it is the one that knows about the multi-select hashes and the stash stack.
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
}

function handleFileKeys(e) {
    var rows = fileRowList();
    if (rows.length === 0) {return;}
    var at = -1;
    for (var i = 0; i < rows.length; i++) {
        if (rows[i].getAttribute('data-path') === state.fileCursor) {at = i;break;}
    }
    var key = e.key;
    if (at < 0 && key !== 'Enter' && key !== 'ArrowRight') {
        selectFileRow(rows[key === 'ArrowUp' || key === 'PageUp' || key === 'End' ? rows.length - 1 : 0]);
        e.preventDefault();
        return;
    }
    var target;
    switch (key) {
        case 'ArrowDown': target = at + 1; break;
        case 'ArrowUp': target = at - 1; break;
        case 'Home': target = 0; break;
        case 'End': target = rows.length - 1; break;
        case 'PageDown': target = at + 10; break;
        case 'PageUp': target = at - 10; break;
        case 'Enter':
        case 'ArrowRight':
            if (at >= 0) {
                if (isDirRow(rows[at]) && key === 'ArrowRight') {
                    if (!dirRowIsOpen(rows[at])) {rows[at].click();}
                } else if (isDirRow(rows[at]) && key === 'Enter') {
                    rows[at].click();
                } else {
                    openFileRow(rows[at]);
                }
            }
            e.preventDefault();
            return;
        case 'ArrowLeft':
            if (at >= 0) {
                if (isDirRow(rows[at]) && dirRowIsOpen(rows[at])) {
                    rows[at].click();
                } else {
                    // Retreat to the folder the row sits in.
                    var path = rows[at].getAttribute('data-path') || '';
                    var parent = path.substring(0, path.lastIndexOf('/'));
                    if (parent) {
                        for (var j = 0; j < rows.length; j++) {
                            if (rows[j].getAttribute('data-path') === parent) {
                                selectFileRow(rows[j]);
                                break;
                            }
                        }
                    }
                }
            }
            e.preventDefault();
            return;
        default: return;
    }
    e.preventDefault();
    target = Math.max(0, Math.min(target, rows.length - 1));
    if (target !== at) {selectFileRow(rows[target]);}
}

/* --- branch tree --- */

function treeRowList() {
    return Array.from(document.querySelectorAll('#btree .bsec, #btree .bfolder, #btree .bitem, #btree .sitem, #btree .witem'));
}

/** Stable identity for a tree row: re-applying the cursor after a re-render keys on it. */
function treeRowId(row) {
    if (row.classList.contains('bsec')) {return 's|' + row.getAttribute('data-sec');}
    if (row.classList.contains('bfolder')) {return 'f|' + row.getAttribute('data-folder');}
    if (row.classList.contains('sitem')) {return 't|' + row.getAttribute('data-stash');}
    if (row.classList.contains('witem')) {return 'w|' + row.getAttribute('data-worktree');}
    return 'b|' + row.getAttribute('data-branch');
}

function applyTreeCursor() {
    if (!state.treeCursor) {return;}
    treeRowList().forEach(function (row) {
        row.classList.toggle('kcur', treeRowId(row) === state.treeCursor);
    });
}

function selectTreeRow(row) {
    state.treeCursor = treeRowId(row);
    applyTreeCursor();
    row.scrollIntoView({ block: 'nearest' });
}

function treeRowIsOpen(row) {
    if (row.classList.contains('bsec')) {return !state.collapsedSec[row.getAttribute('data-sec')];}
    if (row.classList.contains('bfolder')) {
        // A branch filter forces every folder open, so the folder state does not
        // decide what is visible while one is typed (same for the favorites filter).
        return !!state.bfilter || state.favoritesOnly || !!state.expandedFolder[row.getAttribute('data-folder')];
    }
    return false;
}

function handleBranchKeys(e) {
    var rows = treeRowList();
    if (rows.length === 0) {return;}
    var at = -1;
    for (var i = 0; i < rows.length; i++) {
        if (treeRowId(rows[i]) === state.treeCursor) {at = i;break;}
    }
    var key = e.key;
    if (at < 0 && key !== 'Enter' && key !== 'ArrowRight' && key !== 'ArrowLeft') {
        selectTreeRow(rows[key === 'ArrowUp' || key === 'PageUp' || key === 'End' ? rows.length - 1 : 0]);
        e.preventDefault();
        return;
    }
    var target;
    switch (key) {
        case 'ArrowDown': target = at + 1; break;
        case 'ArrowUp': target = at - 1; break;
        case 'Home': target = 0; break;
        case 'End': target = rows.length - 1; break;
        case 'PageDown': target = at + 8; break;
        case 'PageUp': target = at - 8; break;
        case 'Enter':
            if (at < 0) {return;}
            if (rows[at].classList.contains('bitem')) {
                // Same as double-click: load that branch's commits. Checking out
                // stays a deliberate double-click / menu action.
                rows[at].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            } else if (rows[at].classList.contains('sitem')) {
                selectStash(parseInt(rows[at].getAttribute('data-stash'), 10));
            } else if (rows[at].classList.contains('witem')) {
                // Same as a double-click: open that worktree in a new window,
                // unless it is the one this window already shows.
                rows[at].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            } else if (!isTreeLeaf(rows[at])) {
                rows[at].click();
            }
            e.preventDefault();
            return;
        case 'ArrowRight':
            if (at >= 0 && !isTreeLeaf(rows[at]) && !treeRowIsOpen(rows[at])) {rows[at].click();}
            e.preventDefault();
            return;
        case 'ArrowLeft':
            if (at >= 0 && !isTreeLeaf(rows[at]) && treeRowIsOpen(rows[at])) {rows[at].click();}
            e.preventDefault();
            return;
        default: return;
    }
    e.preventDefault();
    target = Math.max(0, Math.min(target, rows.length - 1));
    if (target !== at) {selectTreeRow(rows[target]);}
}

function isTreeLeaf(row) {
    return row.classList.contains('bitem') || row.classList.contains('sitem') || row.classList.contains('witem');
}

var NAV_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Enter'];

document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) {return;}
    if (e.key === 'Escape') {
        // The menu otherwise only goes away when the next click lands elsewhere,
        // which is invisible to anyone reaching it from the keyboard.
        var menu = document.querySelector('.context-menu');
        if (menu) {
            menu.remove();
            if (window._hideTooltip) {window._hideTooltip();}
            e.preventDefault();
        }
        return;
    }
    if (uiOverlayIsOpen()) {return;}

    var pane = activeKeyPane();
    if (!pane) {
        if (e.key === 'Tab') {return;}
        // Right after the panel opens nothing inside it has focus. The arrows then
        // belong to the commit list — the one pane the panel is about — instead of
        // doing nothing until the user clicks. Body-level scrolling is not a thing
        // here: every scrollable region is a pane.
        var focusedBody = !document.activeElement || document.activeElement === document.body ||
            document.activeElement === document.documentElement;
        if (!focusedBody || NAV_KEYS.indexOf(e.key) < 0) {return;}
        pane = 'commits';
        var scrollEl = document.getElementById('scroll');
        if (scrollEl) {scrollEl.focus();}
    }
    if (e.key === 'Tab') {
        e.preventDefault();
        movePaneFocus(e.shiftKey ? -1 : 1);
        return;
    }
    // Shift only extends a commit range, as it does with the mouse.
    if (e.shiftKey && pane !== 'commits') {return;}
    if (pane === 'commits') {handleCommitKeys(e);}
    else if (pane === 'files') {handleFileKeys(e);}
    else {handleBranchKeys(e);}
});

/* ---------- repository guidance page (no git / no repo / no commits) ---------- */
var REPO_ICONS = {
    noGit: '<svg width="34" height="34" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M2 4.5 6 2l4 2.5v3L6 10 2 7.5z"/><circle cx="11" cy="11" r="2.6"/><path d="M13 13l1.6 1.6"/></svg>',
    noRepo: '<svg width="34" height="34" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="4" cy="3.5" r="1.8"/><circle cx="4" cy="12.5" r="1.8"/><circle cx="12" cy="8" r="1.8"/><path d="M4 5.3v5.4M5.6 4.4l4.8 2.8M5.6 11.6l4.8-2.8"/></svg>',
    emptyRepo: '<svg width="34" height="34" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M2 5.5h12v8H2z"/><path d="M2 5.5 4 2h8l2 3.5"/><path d="M6.5 9h3"/></svg>'
};

function repoStateCopy(repoState, folder, files) {
    if (repoState === 'noGit') {
        return {
            title: T('repo.noGitTitle'),
            body: T('repo.noGitBody'),
            actions: [{ key: 'recheckRepository', label: T('repo.recheck'), primary: true }]
        };
    }
    if (repoState === 'noRepo') {
        var found = state.repositories || [];
        // The guidance page is an opaque overlay, so the switcher underneath it is
        // unreachable. In a workspace that is a plain parent of several projects
        // (the layout this panel is built for) the useful action is picking one of
        // them — list them right here instead of only offering to `git init`.
        if (found.length > 0) {
            return {
                title: T('repo.noRepoTitle'),
                body: T('repo.noRepoFoundBody', { n: found.length }),
                actions: [
                    { key: 'initRepository', label: T('repo.init') },
                    { key: 'recheckRepository', label: T('repo.recheck') }
                ],
                repos: found
            };
        }
        return {
            title: T('repo.noRepoTitle'),
            body: T('repo.noRepoBody', { folder: folder || '' }),
            actions: [
                { key: 'initRepository', label: T('repo.init'), primary: true },
                { key: 'recheckRepository', label: T('repo.recheck') }
            ]
        };
    }
    if (repoState === 'emptyRepo') {
        return {
            title: T('repo.emptyTitle'),
            body: files > 0 ? T('repo.emptyPending', { files: files }) : T('repo.emptyClean'),
            actions: [
                { key: 'openScmView', label: T('repo.openScm'), primary: true },
                { key: 'recheckRepository', label: T('repo.recheck') }
            ]
        };
    }
    return null;
}

/* ---------- repository switcher (multi-root workspaces) ---------- */

/** Compare two repository paths the way the host does: separators and case. */
function repoKey(p) {
    return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function sameRepo(a, b) {
    return !!a && !!b && repoKey(a) === repoKey(b);
}

/**
 * The switcher only shows up when there is something to switch between: with a
 * single repository it would be a menu holding one entry.
 */
function renderRepoSwitcher() {
    var row = document.getElementById('repo-row');
    var name = document.getElementById('repo-switch-name');
    if (!row || !name) { return; }
    // The list this menu shows is exactly what just changed.
    closeRepositoryMenu();
    var repos = state.repositories || [];
    if (repos.length < 2) {
        row.style.display = 'none';
        return;
    }
    var current = repos.filter(function (r) { return sameRepo(r.path, state.currentRepository); })[0];
    // A pinned root can sit outside the scanned trees (a linked worktree), so fall
    // back to its own folder name; with nothing resolved the chip is the way out of
    // the guidance page and needs a label of its own rather than an empty name.
    var label = current ? current.name
        : String(state.currentRepository || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    name.textContent = label || T('repo.title');
    name.setAttribute('data-title', state.currentRepository || T('repo.hint'));
    row.style.display = '';
}

/**
 * The repository list is a pick, not a dialog: an inline dropdown under the chip
 * keeps the branch tree and the commit rows visible while choosing.
 */
var repoMenu = { open: false, index: -1 };

function renderRepositoryMenu() {
    var menu = document.getElementById('repo-menu');
    if (!menu) { return; }
    menu.innerHTML = (state.repositories || []).map(function (r) {
        var cur = sameRepo(r.path, state.currentRepository);
        return '<div class="repo-item' + (cur ? ' cur' : '') + '" data-path="' + esc(r.path) + '">' +
            '<span class="repo-item-name">' + esc(r.name) + '</span>' +
            '<span class="repo-item-path" data-title="' + esc(r.path) + '">' + esc(r.path) + '</span>' +
            (cur ? '<span class="repo-item-mark">' + T('repo.current') + '</span>' : '') +
            '</div>';
    }).join('');
}

function highlightRepository(index) {
    var menu = document.getElementById('repo-menu');
    if (!menu) { return; }
    var items = menu.querySelectorAll('.repo-item');
    if (items.length === 0) { return; }
    repoMenu.index = Math.max(0, Math.min(index, items.length - 1));
    for (var i = 0; i < items.length; i++) {
        items[i].classList.toggle('hl', i === repoMenu.index);
    }
    items[repoMenu.index].scrollIntoView({ block: 'nearest' });
}

function openRepositoryMenu() {
    var menu = document.getElementById('repo-menu');
    var btn = document.getElementById('repo-switch');
    if (!menu || !btn) { return; }
    renderRepositoryMenu();
    menu.style.display = '';
    btn.classList.add('open');
    repoMenu.open = true;
    // Start the keyboard on the repository being shown.
    var items = menu.querySelectorAll('.repo-item');
    repoMenu.index = -1;
    for (var i = 0; i < items.length; i++) {
        if (items[i].classList.contains('cur')) { highlightRepository(i); break; }
    }
}

function closeRepositoryMenu() {
    var menu = document.getElementById('repo-menu');
    var btn = document.getElementById('repo-switch');
    if (menu) { menu.style.display = 'none'; }
    if (btn) { btn.classList.remove('open'); }
    repoMenu.open = false;
    repoMenu.index = -1;
}

function pickRepository(item) {
    if (!item) { return; }
    var picked = item.getAttribute('data-path');
    closeRepositoryMenu();
    // Re-picking the visible repository is a no-op, not a reload.
    if (!sameRepo(picked, state.currentRepository)) {
        vscode.postMessage({ command: 'selectRepository', path: picked });
    }
}

function renderRepoState() {
    var box = document.getElementById('repo-state');
    if (!box) { return; }
    var copy = repoStateCopy(state.repoState, state.repoFolder, state.repoPendingFiles);
    if (!copy) {
        box.className = '';
        box.innerHTML = '';
        return;
    }
    var btns = copy.actions.map(function (a) {
        return '<button type="button" class="dialog-btn ' + (a.primary ? 'primary' : 'secondary') +
            '" data-repo-action="' + a.key + '">' + esc(a.label) + '</button>';
    }).join('');
    var picks = (copy.repos || []).map(function (r) {
        return '<button type="button" class="rs-repo" data-repo-pick="' + esc(r.path) + '" data-title="' + esc(r.path) + '">' +
            '<span class="rs-repo-name">' + esc(r.name) + '</span>' +
            '<span class="rs-repo-path">' + esc(r.path) + '</span>' +
            '</button>';
    }).join('');
    box.className = 'on ' + state.repoState;
    box.innerHTML = '<div class="rs-card">' +
        '<div class="rs-icon">' + (REPO_ICONS[state.repoState] || '') + '</div>' +
        '<div class="rs-title">' + esc(copy.title) + '</div>' +
        '<div class="rs-body">' + esc(copy.body) + '</div>' +
        (picks ? '<div class="rs-repos">' + picks + '</div>' : '') +
        '<div class="rs-actions">' + btns + '</div>' +
        '</div>';
}

var repoStateBox = document.getElementById('repo-state');
if (repoStateBox) {
    repoStateBox.addEventListener('click', function (e) {
        var pick = e.target.closest('[data-repo-pick]');
        if (pick) {
            vscode.postMessage({ command: 'selectRepository', path: pick.getAttribute('data-repo-pick') });
            return;
        }
        var btn = e.target.closest('[data-repo-action]');
        if (!btn) { return; }
        vscode.postMessage({ command: btn.getAttribute('data-repo-action') });
    });
}

var repoSwitchBtn = document.getElementById('repo-switch');
if (repoSwitchBtn) {
    repoSwitchBtn.addEventListener('click', function () {
        if (repoMenu.open) { closeRepositoryMenu(); } else { openRepositoryMenu(); }
    });
}

var repoMenuEl = document.getElementById('repo-menu');
if (repoMenuEl) {
    repoMenuEl.addEventListener('click', function (e) {
        pickRepository(e.target.closest('.repo-item'));
    });
}

// Anywhere else dismisses it. The chip is inside #repo-row and toggles itself, so
// excluding that element keeps its click from being closed and reopened at once.
document.addEventListener('click', function (e) {
    if (repoMenu.open && !e.target.closest('#repo-row')) { closeRepositoryMenu(); }
});

document.addEventListener('keydown', function (e) {
    if (!repoMenu.open) { return; }
    if (e.key === 'Escape') { closeRepositoryMenu(); return; }
    if (e.key === 'ArrowDown') { highlightRepository(repoMenu.index + 1); }
    else if (e.key === 'ArrowUp') { highlightRepository(repoMenu.index - 1); }
    else if (e.key === 'Enter') {
        pickRepository(document.querySelectorAll('#repo-menu .repo-item')[repoMenu.index]);
    } else { return; }
    // The list filters nothing, so the keys belong to the menu, not to a field.
    e.preventDefault();
});

window.addEventListener('message', function (ev) {
    var m = ev.data;
    if (m.command === 'setFileIconTheme') {
        state.iconPack = m.pack || null;
        applyIconFont(state.iconPack);
        renderDetail();
    } else if (m.command === 'setRepoState') {
        state.repoState = m.state || 'ready';
        state.repoPendingFiles = typeof m.files === 'number' ? m.files : 0;
        state.repoFolder = m.folder || '';
        state.repositories = m.repositories || [];
        state.currentRepository = m.currentRepository || '';
        renderRepoSwitcher();
        if (state.repoState !== 'ready') {
            // No data will ever arrive to clear the startup skeleton
            loadState.initialLoad = false;
            hideInitialLoading();
            setBusy('rows', false);
        }
        renderRepoState();
    } else if (m.command === 'setData') {
        // Clear all state before setting new data to prevent accumulation
        state.commits = m.commits || [];
        state.local = m.local || [];
        state.remote = m.remote || [];
        state.current = m.currentBranch || '';
        state.selectedBranch = m.selectedBranch || '';
        if (m.repoName) state.repoName = m.repoName;
        state.hasMore = !!m.hasMore;
        state.headHash = m.headHash || '';
        state.inProgress = m.inProgress || null;
        
        // History has arrived — drop the guidance page if it was showing
        if (state.repoState !== 'ready') {
            state.repoState = 'ready';
            renderRepoState();
        }
        
        // Mark branches as loaded
        loadState.branchesLoaded = true;
        if (loadState.initialLoad) {
            loadState.initialLoad = false;
            hideInitialLoading();
        }
        // An external history change (terminal commit, merge landing after conflicts
        // were resolved) reloads the rows underneath the user. Keep their selection
        // when the commit is still in the new list — otherwise the detail panel would
        // vanish every time git moved on its own.
        var keepSelected = !!m.preserveSelection && !!state.selectedHash
            && (m.commits || []).some(function (c) { return c.hash === state.selectedHash; });
        if (keepSelected) {
            state.selectedHashes = [];
            state.multiCommits = null;
            state.multiFiles = null;
        } else {
            state.selectedHash = null;
            state.selectedHashes = []; // Clear multi-select on full data refresh
            state.lastClickedIndex = -1;
            state.multiCommits = null;
            state.multiFiles = null;
            state.detail = null;
            state.stashDetail = null;
            // The file list this preview belonged to is gone with the selection.
            clearPreview();
        }
        
        // Render operation status bar immediately after setting inProgress state
        renderOperationStatus();
        
        // Show search result notification if filters are active
        if (m.searchContext) {
            var count = m.searchContext.resultCount;
            if (count === 0) {
                vscode.postMessage({
                    command: 'showNotification',
                    type: 'info',
                    message: T('w.noCommitFound')
                });
            } else {
                vscode.postMessage({
                    command: 'showStatusBarMessage',
                    message: T('w.foundMatches', { n: count }),
                    timeout: 3000
                });
            }
        }
        
        // Update author dropdown with unique authors from commits
        updateAuthorDropdown(m.commits || []);
        if (!keepSelected) {
            state.collapsed = {};
            state.collapsedSec = {};
        }
        setLoader(false);
        if (!keepSelected) {
            document.getElementById('scroll').scrollTop = 0;
        }
        renderOperationStatus();
        renderTree();
        renderRows();
        renderDetail();
        // Re-apply any pending session restore that arrived before (or during) this
        // full re-render — setData cleared selection/folds/scroll above.
        applyRestoreNow();
    } else if (m.command === 'appendCommits') {
        state.commits = state.commits.concat(m.commits || []);
        state.hasMore = !!m.hasMore;
        setLoader(false);
        renderRows(true);
    } else if (m.command === 'loadMoreFailed') {
        // Keep hasMore: the next scroll retries instead of silently ending the list.
        setLoader(false);
    } else if (m.command === 'setDetail') {
        // A slower answer for a commit the user already clicked away from must
        // not overwrite the panel (revealCommit / refreshFiles can interleave).
        if (!state.selectedHash || m.commit.hash !== state.selectedHash) { return; }
        state.detail = { commit: m.commit, files: m.files };
        renderDetail();
    } else if (m.command === 'filePreviewResponse') {
        // Clicking another file (or another commit) fires a new request; a patch
        // that finishes late must not paint over the selection that replaced it.
        var p = state.preview;
        var key = m.stash !== undefined && m.stash !== null ? 'stash:' + m.stash : 'commit:' + m.hash;
        if (!p || p.loading !== true || p.path !== m.path || p.key !== key) { return; }
        state.preview = {
            path: m.path,
            key: key,
            loading: false,
            lines: m.lines || [],
            truncated: m.truncated === true,
            binary: m.binary === true,
            empty: m.empty === true,
            error: m.error,
        };
        renderPreview();
    } else if (m.command === 'setCurrentBranch') {
        state.current = m.branch;
        renderTree();
    } else if (m.command === 'revealCommit') {
        // A reveal is a single-selection jump from another surface (blame, file
        // history): keep the multi-select set in sync, and drop the previous
        // multi-commit payload — renderDetail() prefers it over state.detail,
        // so leaving it behind would show the old commit's data.
        state.selectedHash = m.hash;
        state.selectedHashes = [m.hash];
        state.lastClickedIndex = -1;
        state.multiCommits = null;
        state.multiFiles = null;
        if (state.stashDetail) {
            state.stashDetail = null;
            renderTree();
        }
        state.detailVisible = true;
        clearPreview();
        applyRowSelection();
        var el = document.querySelector('.row[data-hash="' + m.hash + '"]');
        if (el) el.scrollIntoView({ block: 'center' });
        saveViewState();
        vscode.postMessage({ command: 'selectCommit', hash: m.hash });
    } else if (m.command === 'setDivergence') {
        console.log('[GitCharm Webview] Received divergence:', m.divergence);
        state.divergence = m.divergence || {};
        console.log('[GitCharm Webview] State divergence updated:', state.divergence);
        renderTree();
    } else if (m.command === 'setBranches') {
        // Update only branch lists without affecting commits
        state.local = m.local || [];
        state.remote = m.remote || [];
        if (m.favorites) {state.favorites = m.favorites;}
        if (m.recent) {state.recent = m.recent;}
        if (m.currentBranch) {
            state.current = m.currentBranch;
        }
        // The selected row may have been deleted outside the panel; keep the
        // highlight only while the branch is still in one of the lists.
        if (state.selectedBranch && state.local.indexOf(state.selectedBranch) < 0 &&
            state.remote.indexOf(state.selectedBranch) < 0) {
            state.selectedBranch = '';
        }
        
        // Mark branches as loaded and hide skeleton
        loadState.branchesLoaded = true;
        if (loadState.initialLoad && loadState.commitsLoaded) {
            loadState.initialLoad = false;
            hideInitialLoading();
        }
        
        renderTree();
    } else if (m.command === 'setFavorites') {
        // Starring or unstarring is a preference, not a git change: the branch
        // lists and the commit rows are still accurate, only the marks moved.
        state.favorites = m.favorites || [];
        renderTree();
    } else if (m.command === 'setStashes') {
        // The stash stack lives in the same tree but is re-sent on its own: stashing
        // never moves HEAD, so the commit list has nothing to reload.
        state.stashes = m.stashes || [];
        // Positions shifted (a stash was dropped, or a new one landed on top):
        // what sits at the remembered index is no longer the same stash.
        var sd = state.stashDetail;
        if (sd && !state.stashes.some(function (s) {
            return s.index === sd.index && s.message === sd.message && s.date === sd.date;
        })) {
            state.stashDetail = null;
            state.detail = null;
            clearPreview();
            renderDetail();
        }
        renderTree();
    } else if (m.command === 'setStashDetail') {
        // Only the stash the user is still looking at may paint its files.
        if (!state.stashDetail || state.stashDetail.index !== m.index) { return; }
        state.stashDetail.files = m.files || [];
        state.stashDetail.error = m.error;
        renderDetail();
    } else if (m.command === 'setWorktrees') {
        // Worktrees are another checkout of the same repository. They sit in the
        // tree on their own schedule: adding or removing one never moves HEAD.
        state.worktrees = m.worktrees || [];
        renderTree();
    } else if (m.command === 'showCherryPickResume') {
        // Show resume button on current branch node
        state.cherryPickResume = {
            remainingHashes: m.remainingHashes || [],
            conflictHash: m.conflictHash || ''
        };
        renderTree();
    } else if (m.command === 'addBranchOptimistic') {
        // Optimistically add branch to UI before git operation completes
        var branchName = m.branch;
        if (branchName && !state.local.includes(branchName)) {
            state.local.push(branchName);
            state.local.sort();
        }
        if (m.isCurrent) {
            state.current = branchName;
        }
        renderTree();
    } else if (m.command === 'removeBranchOptimistic') {
        // Optimistically remove branch from UI before git operation completes
        var idx = state.local.indexOf(m.branch);
        if (idx !== -1) {
            state.local.splice(idx, 1);
        }
        // If we're viewing the deleted branch, clear the selection
        if (state.selectedBranch === m.branch) {
            state.selectedBranch = '';
        }
        renderTree();
    } else if (m.command === 'setBranch') {
        // Switch to a different branch view (or all branches if undefined)
        state.selectedBranch = m.branch || '';
        renderTree();
    } else if (m.command === 'renameBranchOptimistic') {
        // Optimistically rename branch in UI before git operation completes
        var oldIdx = state.local.indexOf(m.oldName);
        if (oldIdx !== -1) {
            state.local[oldIdx] = m.newName;
            state.local.sort();
        }
        if (state.current === m.oldName) {
            state.current = m.newName;
        }
        if (state.selectedBranch === m.oldName) {
            state.selectedBranch = m.newName;
        }
        renderTree();
    } else if (m.command === 'setInProgress') {
        // Update in-progress operation status asynchronously
        state.inProgress = m.inProgress || null;
        renderOperationStatus();
    } else if (m.command === 'setHeadHash') {
        // Update head hash asynchronously
        state.headHash = m.headHash || '';
    } else if (m.command === 'setCommits') {
        // Update commits after initial branch display
        state.commits = m.commits || [];
        state.hasMore = !!m.hasMore;
        // Clear multi-select when commit list is refreshed
        state.selectedHashes = [];
        state.lastClickedIndex = -1;
        state.multiCommits = null;
        state.multiFiles = null;
        setLoader(false);
        renderRows();
        applyPendingScroll();
        applyRestoreNow();
    } else if (m.command === 'restoreViewState') {
        // Git Graph-style restoration, deferred through a pending snapshot so it
        // survives the setData re-render that fires on every panel re-show.
        var vs = m.state || {};
        if (vs.branch) { state.selectedBranch = vs.branch; renderTree(); }
        state._pendingRestore = vs;
        applyRestoreNow();
    } else if (m.command === 'loading') {
        setBusy(m.area, !!m.on);
    } else if (m.command === 'showDialog') {
        showDialog(m.message, m.actions || [], m.type || 'warn', function (action) {
            vscode.postMessage({ command: 'dialogAction', action: action });
        });
    } else if (m.command === 'showSquashMessageDialog') {
        showSquashMessageDialog(m.prompt, m.initialValue, m.placeholder);
    } else if (m.command === 'showPushDialog') {
        showPushDialog(m.branchName, m.commits || [], m.remoteExists, m.isFirstPush, m.remote || 'origin', m.remotes || []);
    } else if (m.command === 'pushFilesResponse') {
        window._handlePushFiles(m.hash, m.files || []);
    } else if (m.command === 'showCompareDialog') {
        showCompareDialog(m.branchName, m.currentBranch, m.commits || []);
    } else if (m.command === 'compareFilesResponse') {
        window._handleCompareFiles(m.hash, m.files || []);
    } else if (m.command === 'showFileHistory') {
        showFileHistoryDialog(m.filePath, m.history || []);
    } else if (m.command === 'showReflog') {
        showReflogDialog(m.scope, m.entries || []);
    } else if (m.command === 'multiCommitsResponse') {
        // Rapid clicks fire one request each; an older response can land after a
        // newer one. Apply it only if it still matches the live selection.
        var wanted = state.selectedHashes || [];
        var got = m.commits || [];
        var gotHashes = {};
        for (var gi = 0; gi < got.length; gi++) { gotHashes[got[gi].hash] = true; }
        var matches = wanted.length > 0 && got.length === wanted.length
            && wanted.every(function (h) { return gotHashes[h]; });
        if (!matches) { return; }
        state.multiCommits = got;
        state.multiFiles = m.files || [];
        renderDetail();
    }
});

/* ---- custom theme-aware dialog ---- */
var dialogIconMap = {
    warn: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 1L1 14h14L8 1z" fill="currentColor"/></svg>',
    info: '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 7v4M8 5.5v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    error: '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
};

function showDialog(message, actions, type, onPick) {
    var overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';
    var iconSvg = dialogIconMap[type] || dialogIconMap.warn;
    var btns = actions.map(function (a, i) {
        var cls = i === 0 ? 'primary' : 'secondary';
        return '<button class="dialog-btn ' + cls + '" data-action="' + esc(a) + '">' + esc(a) + '</button>';
    }).join('');
    overlay.innerHTML = '<div class="dialog-box">' +
        '<div class="dialog-title"><span class="dialog-icon ' + type + '">' + iconSvg + '</span><span>' + esc(message) + '</span></div>' +
        '<div class="dialog-actions">' + btns + '</div></div>';
    document.body.appendChild(overlay);
    overlay.querySelectorAll('.dialog-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var action = btn.getAttribute('data-action');
            overlay.remove();
            onPick(action);
        });
    });
}

/* ---- squash message dialog (multi-line editor) ---- */
function showSquashMessageDialog(prompt, initialValue, placeholder) {
    var overlay = document.createElement('div');
    overlay.className = 'squash-dialog-overlay';
    
    var textarea = document.createElement('textarea');
    textarea.className = 'squash-textarea';
    textarea.value = initialValue || '';
    textarea.placeholder = placeholder || '';
    textarea.rows = 10;
    textarea.cols = 60;
    
    var btns = '<div class="squash-dialog-actions">' +
        '<button class="squash-btn primary" data-action="squash">' + esc(T('commit.squashBtn') || '压缩') + '</button>' +
        '<button class="squash-btn secondary" data-action="cancel">' + esc(T('common.cancel') || '取消') + '</button>' +
        '</div>';
    
    overlay.innerHTML = '<div class="squash-dialog-box">' +
        '<div class="squash-dialog-title">' + esc(prompt) + '</div>' +
        '<div class="squash-dialog-content"></div>' +
        btns +
        '</div>';
    
    // Insert textarea into content area
    var contentArea = overlay.querySelector('.squash-dialog-content');
    contentArea.appendChild(textarea);
    
    document.body.appendChild(overlay);
    
    // Focus textarea and select all text
    textarea.focus();
    textarea.select();
    
    // Handle button clicks
    overlay.querySelectorAll('.squash-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var action = btn.getAttribute('data-action');
            if (action === 'squash') {
                vscode.postMessage({ 
                    command: 'squashMessageResponse', 
                    message: textarea.value 
                });
            } else {
                vscode.postMessage({ 
                    command: 'squashMessageResponse' 
                });
            }
            overlay.remove();
        });
    });
    
    // Handle Escape key
    overlay.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
            vscode.postMessage({ 
                command: 'squashMessageResponse' 
            });
            overlay.remove();
        }
    });
}

/* ---- push confirmation dialog ---- */
/* ---------- shared: push / compare dialog body ---------- */

/** Commit row: no hash column — the full details live in the hover tooltip and the info pane. */
function dialogCommitRowHtml(c, selected) {
    var cleanMessage = c.message.replace(/^`{1,3}\s*/, '');
    var tip = cleanMessage + '\n' + c.author + ' · ' + fmtDate(c.date) + ' (' + fmtRelativeTime(c.date) + ')\n' + c.hash;
    return '<div class="push-commit-row' + (selected ? ' sel' : '') + '" data-hash="' + esc(c.hash) + '" data-title="' + esc(tip) + '">' +
        '<span class="push-commit-msg">' + esc(cleanMessage) + '</span>' +
        '<span class="push-commit-author">' + esc(c.author) + '</span>' +
        '<span class="push-commit-date" data-title="' + esc(fmtDate(c.date)) + '">' + esc(fmtRelativeTime(c.date)) + '</span>' +
        '</div>';
}

/** Right-hand side: changed files on top, commit info below; each scrolls on both axes. */
function dialogSidePanelHtml(ids) {
    return '<div class="push-files-panel">' +
        '<div class="push-files-section">' +
        '<div class="push-files-head" id="' + ids.head + '"></div>' +
        '<div class="push-files-scroll"><div class="push-files-list" id="' + ids.list + '"></div></div>' +
        '</div>' +
        '<div class="push-detail-section" id="' + ids.detail + '"></div>' +
        '</div>';
}

function dialogFileRowHtml(r) {
    var pad = fileRowPad(r.depth);
    if (r.kind === 'dir') {
        return '<div class="push-file-row dir" data-path="' + esc(r.path) + '" style="' + pad + '"><span class="caret">' + (r.closed ? I_CARET_R : I_CARET_D) + '</span>' + (r.closed ? I_FOLDER : I_FOLDER_OPEN) + '<span class="push-file-name" data-title="' + esc(r.path) + '">' + esc(r.name) + '</span><span class="fcount">' + r.count + '</span></div>';
    }
    var f = r.file;
    return '<div class="push-file-row file" data-path="' + esc(f.path) + '" style="' + pad + '">' +
        '<span class="push-file-status ' + esc(f.status || '') + '">' + esc(f.status || '?') + '</span>' +
        '<span class="push-file-name" data-title="' + esc(f.path) + '">' + esc(r.name) + '</span></div>';
}

function renderDialogFiles(headEl, listEl, files, st) {
    if (!listEl) {return;}
    var mode = st.fileViewMode || FILE_MODE_TREE;
    var btn = fileModeBtnHtml(mode);
    if (!files || files.length === 0) {
        if (headEl) {headEl.innerHTML = '<span>' + T('common.noFileChanges') + '</span>' + btn;}
        listEl.innerHTML = '';
        return;
    }
    if (headEl) {headEl.innerHTML = '<span>' + T('w.filesCount', { n: files.length }) + '</span>' + btn;}
    listEl.innerHTML = buildFileRows(files, mode, st.collapsedDirs || {}, dialogFileRowHtml);
}

/** Info pane: a single commit, or the aggregate summary for the '__all__' row. */
function renderDialogDetail(el, commit, commits) {
    if (!el) {return;}
    if (commit) {
        var clean = commit.message.replace(/^`{1,3}\s*/, '');
        var initial = esc((commit.author || '?').charAt(0).toUpperCase());
        el.innerHTML = '<div class="ccard">' +
            '<div class="crow"><span class="hashchip">' + esc(commit.shortHash) + '</span></div>' +
            '<div class="crow"><span class="cmsg">' + esc(clean) + '</span></div>' +
            '<div class="crow"><span class="avatar" style="background:' + avatarColor(commit.author || '?') + '">' + initial + '</span>' +
            '<span class="cmeta">' + esc(commit.author) + ' · ' + esc(fmtDate(commit.date)) + ' (' + esc(fmtRelativeTime(commit.date)) + ')</span></div>' +
            '<div class="crow"><span class="cmeta push-full-hash">' + esc(commit.hash) + '</span></div>' +
            '</div>';
        return;
    }
    var list = commits || [];
    if (list.length === 0) {
        el.innerHTML = '<div class="push-files-empty">' + T('common.noCommitSelected') + '</div>';
        return;
    }
    var authors = [];
    list.forEach(function (c) {
        if (authors.indexOf(c.author) === -1) {authors.push(c.author);}
    });
    el.innerHTML = '<div class="ccard">' +
        '<div class="crow"><span class="cmsg">' + T('pushDlg.allCommits') + '</span></div>' +
        '<div class="crow"><span class="cmeta">' + T('common.commitCount', { n: list.length }) + '</span></div>' +
        '<div class="crow"><span class="cmeta">' + T('w.authorPrefix') + esc(authors.join(', ')) + '</span></div>' +
        '<div class="crow"><span class="cmeta">' + esc(fmtDate(list[list.length - 1].date)) + ' → ' + esc(fmtDate(list[0].date)) + '</span></div>' +
        '</div>';
}

var pushState = { commits: [], selectedHash: null, filesCache: {}, branchName: '', remoteExists: true, visibleCount: 20, fileViewMode: 'tree', collapsedDirs: {} };

/* ---------- drag-to-resize dialog ---------- */

// Deliberately plain module state: the webview DOM is destroyed when the panel is
// hidden, and this object dies with it, so the next session starts from the
// stylesheet defaults. Nothing here is reported to the host or written to Memento.
// One slot per dialog: the reflog is naturally a third of the push dialog's
// height, so a shared frame would inflate whichever dialog the user did not just
// drag. The size still survives a rebuild (switching the push remote re-renders
// the whole overlay) and reopening the same dialog.
var dialogLayout = {};
function layoutSlot(key) {
    var l = dialogLayout[key];
    if (!l) {dialogLayout[key] = l = { box: null, list: null, files: null };}
    return l;
}
var BOX_MIN_W = 560, BOX_MIN_H = 340;
var LIST_MIN_W = 220, PANE_MIN_W = 260;
var FILES_MIN_H = 90, DETAIL_MIN_H = 96;

function clampPx(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

/**
 * Drag bounds as "how far each way from where it started", never as absolute
 * floors: a pane already past an absolute floor makes the first pointermove snap
 * it back, which reads as the divider moving the wrong way.
 */
function dragRange(start, back, fwd) {
    var lo = start - Math.max(0, back), hi = start + Math.max(0, fwd);
    return function (d) { return clampPx(start + d, lo, hi); };
}

/**
 * A single grip drag. Pointer capture is what makes it survive: the grips are a
 * few pixels wide, so the cursor leaves them almost immediately, and without
 * capture the drag would read as "released outside" and be dropped.
 * The callback gets a named `{dx, dy}` — two of these handlers only care about
 * one axis, and positional arguments let that quietly bind to the wrong one.
 */
function startDialogDrag(e, cursor, move) {
    if (e.button !== 0) {return;}
    var grip = e.currentTarget;
    e.preventDefault();
    e.stopPropagation();
    var startX = e.clientX, startY = e.clientY;
    document.body.classList.add('dialog-resizing');
    document.body.style.cursor = cursor;
    try { grip.setPointerCapture(e.pointerId); } catch (err) {/* unsynthesised pointers have nothing to capture */}
    function onMove(ev) { move({ dx: ev.clientX - startX, dy: ev.clientY - startY }); }
    function onUp() {
        grip.removeEventListener('pointermove', onMove);
        grip.removeEventListener('pointerup', onUp);
        grip.removeEventListener('pointercancel', onUp);
        document.body.classList.remove('dialog-resizing');
        document.body.style.cursor = '';
    }
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onUp);
    grip.addEventListener('pointercancel', onUp);
}

/** Free the column from its percentage cap and pin the file/commit split height. */
function setDialogRowSplit(top, bottom, h) {
    /* flex-shrink stays 1 so a later box-height drag can still take the pane down;
       only the grow is switched off, otherwise the basis is ignored. */
    top.style.flex = '0 1 ' + Math.round(h) + 'px';
    bottom.style.flex = '1 1 auto';
}

/**
 * Freeze the frame before an inner divider moves. The box has no height of its
 * own — it is content-sized and the overlay centres it — so taking a pane down
 * shrinks the whole dialog, which then re-centres and the divider jumps the way
 * the cursor did not. Pinned sizes use offset*, not getBoundingClientRect: the
 * opening animation is a transform and would be baked in as a real size.
 */
function pinDialogBox(lay, box) {
    if (box.style.height) {return;}
    lay.box = { w: box.offsetWidth, h: box.offsetHeight };
    box.style.maxHeight = 'none';
    box.style.width = lay.box.w + 'px';
    box.style.height = lay.box.h + 'px';
}

function attachDialogResize(overlay, key) {
    var box = overlay.querySelector('.push-dialog-box');
    var body = overlay.querySelector('.push-dialog-body');
    var list = overlay.querySelector('.push-commits-list');
    var panel = overlay.querySelector('.push-files-panel');
    if (!box || !body || !list) {return;}
    var lay = layoutSlot(key);
    var filesSec = panel && panel.querySelector('.push-files-section');
    var detailSec = panel && panel.querySelector('.push-detail-section');
    if (lay.box) {
        box.style.width = lay.box.w + 'px';
        box.style.height = lay.box.h + 'px';
        box.style.maxHeight = 'none';
    }

    ['e', 's', 'se'].forEach(function (dir) {
        var grip = document.createElement('div');
        grip.className = 'push-rz push-rz-' + dir;
        box.appendChild(grip);
        grip.addEventListener('pointerdown', function (e) {
            var startW = box.offsetWidth, startH = box.offsetHeight;
            var startFiles = lay.files;
            var spanW = dragRange(startW, startW - BOX_MIN_W, window.innerWidth - 24 - startW);
            var spanH = dragRange(startH, startH - BOX_MIN_H, window.innerHeight - 24 - startH);
            startDialogDrag(e, dir === 'e' ? 'ew-resize' : dir === 's' ? 'ns-resize' : 'nwse-resize', function (d) {
                var next = { w: startW, h: startH };
                // The overlay centres the box, so a grabbed edge only travels half the
                // pointer distance; doubling the delta makes the edge follow the cursor.
                if (dir !== 's') {next.w = spanW(d.dx * 2);}
                if (dir !== 'e') {
                    next.h = spanH(d.dy * 2);
                    // Once the split has been dragged it is a fixed height, and the
                    // bottom pane absorbs everything the frame gains. Scale it with the
                    // frame instead, or growing the dialog only ever grows the commit card.
                    if (startFiles && filesSec) {
                        lay.files = startFiles * next.h / startH;
                        setDialogRowSplit(filesSec, detailSec, lay.files);
                    }
                }
                lay.box = next;
                box.style.maxHeight = 'none';
                box.style.width = next.w + 'px';
                box.style.height = next.h + 'px';
            });
        });
    });

    // Reflog and file history are single-column: the frame grips are all they get.
    if (!panel) {return;}
    if (lay.list) {
        list.style.maxWidth = 'none';
        list.style.width = lay.list + 'px';
    }
    var split = document.createElement('div');
    split.className = 'push-split push-split-v';
    body.insertBefore(split, list.nextSibling);
    split.addEventListener('pointerdown', function (e) {
        pinDialogBox(lay, box);
        var startW = list.offsetWidth;
        var span = dragRange(startW, startW - LIST_MIN_W, panel.offsetWidth - PANE_MIN_W);
        startDialogDrag(e, 'col-resize', function (d) {
            lay.list = span(d.dx);
            list.style.maxWidth = 'none';
            list.style.width = lay.list + 'px';
        });
    });

    if (!filesSec || !detailSec) {return;}
    if (lay.files) {setDialogRowSplit(filesSec, detailSec, lay.files);}
    var hsplit = document.createElement('div');
    hsplit.className = 'push-split push-split-h';
    panel.insertBefore(hsplit, detailSec);
    hsplit.addEventListener('pointerdown', function (e) {
        pinDialogBox(lay, box);
        var startH = filesSec.offsetHeight;
        var span = dragRange(startH, startH - FILES_MIN_H, detailSec.offsetHeight - DETAIL_MIN_H);
        startDialogDrag(e, 'row-resize', function (d) {
            lay.files = span(d.dy);
            setDialogRowSplit(filesSec, detailSec, lay.files);
        });
    });
}

function showPushDialog(branchName, commits, remoteExists, isFirstPush, remote, remotes) {
    // The host re-sends this message when the target remote changes; replace the
    // open dialog instead of stacking a second overlay.
    var existing = document.getElementById('push-dialog');
    if (existing) { existing.remove(); }
    // '__all__' is the synthetic aggregate row ("全部提交") diffing base ref vs local tip
    pushState = { commits: commits, selectedHash: commits.length > 0 ? '__all__' : null, filesCache: {}, branchName: branchName, remoteExists: remoteExists !== false, visibleCount: 20, fileViewMode: state.fileViewMode || 'tree', collapsedDirs: {} };
    var overlay = document.createElement('div');
    overlay.className = 'push-dialog-overlay';
    overlay.id = 'push-dialog';

    // Aggregate row: all files differing from the remote (listed before the commit rows)
    var allRowHtml = '';
    if (commits.length > 0) {
        allRowHtml = '<div class="push-commit-row push-all-row sel" data-hash="__all__" data-title="' + esc(T('pushDlg.allCommitsTip')) + '">' +
            '<span class="push-commit-msg push-all-label">' + T('pushDlg.allCommits') + '</span>' +
            '<span class="push-commit-date">' + T('common.commitCount', { n: commits.length }) + '</span>' +
            '</div>';
    }

    // Render initial batch of commits (first 20)
    function renderCommitBatch(startIdx, endIdx) {
        return commits.slice(startIdx, endIdx).map(function (c) {
            return dialogCommitRowHtml(c, c.hash === pushState.selectedHash);
        }).join('');
    }

    var commitRows = renderCommitBatch(0, 20);

    // Add placeholder when no commits (for new branches or first push)
    var emptyStateHtml = '';
    if (commits.length === 0) {
        if (isFirstPush || !pushState.remoteExists) {
            emptyStateHtml = '<div class="push-empty-state">' +
                '<div class="push-empty-icon">📦</div>' +
                '<div class="push-empty-text">' + T('pushDlg.firstPushText') + '</div>' +
                '<div class="push-empty-hint">' + T('pushDlg.firstPushHint') + '</div>' +
                '</div>';
        } else {
            // The dialog opens even when nothing is ahead — say why it is empty
            // instead of showing a blank list the user has to interpret.
            emptyStateHtml = '<div class="push-empty-state">' +
                '<div class="push-empty-icon">✓</div>' +
                '<div class="push-empty-text">' + T('pushDlg.upToDateText') + '</div>' +
                '<div class="push-empty-hint">' + T('pushDlg.upToDateHint') + '</div>' +
                '</div>';
        }
    }

    // Add "Load More" button if there are more than 20 commits
    var loadMoreHtml = '';
    if (commits.length > 20) {
        var remainingCount = Math.min(20, commits.length - 20);
        loadMoreHtml = '<div class="push-load-more-container"><button class="push-load-more-btn">' + T('common.loadMoreCommits', { n: commits.length - 20 }) + '</button></div>';
    }

    var targetRemote = remote || 'origin';
    // Multi-remote repositories get a picker; switching it reloads the preview
    // from the host, so the commit list always describes the visible target.
    var remoteOptions = remotes || [];
    if (remoteOptions.length > 1 && remoteOptions.indexOf(targetRemote) < 0) {
        remoteOptions = [targetRemote].concat(remoteOptions);
    }
    var remoteControl = esc(targetRemote);
    if (remoteOptions.length > 1) {
        var optionHtml = remoteOptions.map(function (r) {
            return '<option value="' + esc(r) + '"' + (r === targetRemote ? ' selected' : '') + '>' + esc(r) + '</option>';
        }).join('');
        remoteControl = '<select class="push-remote-select" id="push-remote-select" data-title="' +
            esc(T('pushDlg.target')) + '">' + optionHtml + '</select>';
    }
    var remoteLabel = remoteControl + '<span class="push-target-path" data-title="' +
        esc(targetRemote + '/' + branchName) + '">/' + esc(branchName) + '</span>' +
        (pushState.remoteExists ? '' : ' <span class="push-new-badge">(new)</span>');
    var commitCountText = commits.length > 0 ? T('common.commitCount', { n: commits.length }) : (pushState.remoteExists ? T('pushDlg.upToDate') : T('pushDlg.firstPush'));
    // Each segment is its own flex item with a stable identity: the source branch,
    // the target (remote + path, never split by the manage button), the manage
    // link, and the count pushed to the right. Flattening them into one text run
    // let the header wrap mid-branch-name and stack 管理 vertically.
    var headerText = '<span class="push-head-branch" data-title="' + esc(branchName) + '">' + esc(branchName) + '</span>' +
        '<span class="push-arrow">→</span>' +
        '<span class="push-head-target">' + remoteLabel + '</span>' +
        '<button class="push-remote-manage" id="push-remote-manage" data-title="' + esc(T('remote.manageTitle')) + '">' +
        esc(T('remote.manageBtn')) + '</button>' +
        '<span class="push-head-count">' + esc(commitCountText) + '</span>';

    overlay.innerHTML = '<div class="push-dialog-box">' +
        '<div class="push-dialog-header">' + headerText + '</div>' +
        '<div class="push-dialog-body">' +
        '<div class="push-commits-list"><div class="push-commits-scroll" id="push-commits-scroll">' + allRowHtml + commitRows + emptyStateHtml + loadMoreHtml + '</div></div>' +
        dialogSidePanelHtml({ head: 'push-files-head', list: 'push-files-list', detail: 'push-commit-detail' }) +
        '</div>' +
        '<div class="push-dialog-actions">' +
        '<button class="dialog-btn secondary" data-action="cancel">' + T('common.cancel') + '</button>' +
        '<button class="dialog-btn primary" data-action="push" data-force="false">' + T('pushDlg.pushBtn') + '</button>' +
        '<button class="dialog-btn danger" data-action="force" data-force="true">' + T('pushDlg.forcePushBtn') + '</button>' +
        '</div></div>';

    document.body.appendChild(overlay);
    attachDialogResize(overlay, 'push');

    // Disable the picker while the host recomputes; the replacement dialog
    // (same id) arrives with the new commit list and an enabled picker.
    var remoteSelect = overlay.querySelector('#push-remote-select');
    if (remoteSelect) {
        remoteSelect.addEventListener('change', function () {
            remoteSelect.disabled = true;
            vscode.postMessage({ command: 'pushDialogRemote', remote: remoteSelect.value });
        });
    }

    // Remote management opens the host's quick-pick flow; the host re-renders
    // this dialog afterwards, so add/remove/rename is reflected in the picker.
    var manageRemotes = overlay.querySelector('#push-remote-manage');
    if (manageRemotes) {
        manageRemotes.addEventListener('click', function () {
            manageRemotes.disabled = true;
            vscode.postMessage({ command: 'manageRemotes' });
        });
    }

    // Commit row click handler
    function attachCommitClickHandlers() {
        overlay.querySelectorAll('.push-commit-row').forEach(function (row) {
            row.addEventListener('click', function () {
                overlay.querySelectorAll('.push-commit-row').forEach(function (r) { r.classList.remove('sel'); });
                row.classList.add('sel');
                pushState.selectedHash = row.getAttribute('data-hash');
                loadPushFiles(row.getAttribute('data-hash'));
            });
        });
    }
    attachCommitClickHandlers();

    // Load More button click - load in batches of 20
    var loadMoreBtn = overlay.querySelector('.push-load-more-btn');
    if (loadMoreBtn) {
        loadMoreBtn.addEventListener('click', function () {
            var scrollContainer = overlay.querySelector('#push-commits-scroll');
            if (!scrollContainer) return;
            
            var currentVisible = pushState.visibleCount || 20;
            var nextBatchEnd = Math.min(currentVisible + 20, commits.length);
            
            // Render next batch
            var newRows = renderCommitBatch(currentVisible, nextBatchEnd);
            
            // Insert before the load more button
            var loadMoreContainer = overlay.querySelector('.push-load-more-container');
            if (loadMoreContainer) {
                var tempDiv = document.createElement('div');
                tempDiv.innerHTML = newRows;
                while (tempDiv.firstChild) {
                    loadMoreContainer.parentNode.insertBefore(tempDiv.firstChild, loadMoreContainer);
                }
            }
            
            // Update visible count
            pushState.visibleCount = nextBatchEnd;
            
            // Re-attach click handlers to new rows
            attachCommitClickHandlers();
            
            // Update or remove load more button
            if (nextBatchEnd < commits.length) {
                var remainingCount = commits.length - nextBatchEnd;
                loadMoreBtn.textContent = T('common.loadMoreCommits', { n: remainingCount });
            } else {
                loadMoreBtn.parentElement.remove();
            }
        });
    }

    // Action buttons
    overlay.querySelectorAll('.push-dialog-actions .dialog-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var action = btn.getAttribute('data-action');
            var force = btn.getAttribute('data-force') === 'true';
            overlay.remove();
            vscode.postMessage({ command: 'pushDialogAction', action: action, force: force });
        });
    });

    // File pane: mode switch, folder collapse, double-click diff (delegated once)
    attachFilePaneHandlers(overlay, pushState, refreshPushFiles, function (path) {
        vscode.postMessage({ command: 'pushDialogFileDiff', hash: pushState.selectedHash || '__all__', path: path });
    });

    // Load files for the aggregate row by default
    if (commits.length > 0) {
        loadPushFiles('__all__');
    } else {
        // First push with nothing staged yet: still show the pane chrome + mode switch
        renderPushDetail('__all__');
        renderDialogFiles(document.getElementById('push-files-head'), document.getElementById('push-files-list'), [], pushState);
    }
}

/** Mode toggle + folder collapse + double-click diff for a dialog's file pane. */
function attachFilePaneHandlers(overlay, st, refresh, onDblClick) {
    var panel = overlay.querySelector('.push-files-panel');
    if (!panel) {return;}
    panel.addEventListener('click', function (e) {
        var btn = e.target.closest('.fmode-btn');
        if (btn) {
            st.fileViewMode = btn.getAttribute('data-fmode');
            refresh();
            return;
        }
        var dir = e.target.closest('.push-file-row.dir');
        if (dir) {
            var p = dir.getAttribute('data-path');
            if (st.collapsedDirs[p]) {delete st.collapsedDirs[p];} else {st.collapsedDirs[p] = true;}
            refresh();
        }
    });
    panel.addEventListener('dblclick', function (e) {
        var row = e.target.closest('.push-file-row.file');
        if (!row) {return;}
        onDblClick(row.getAttribute('data-path'));
    });
}

function refreshPushFiles() {
    var files = pushState.filesCache[pushState.selectedHash];
    if (!files) {return;} // still loading: keep the spinner
    renderDialogFiles(document.getElementById('push-files-head'), document.getElementById('push-files-list'), files, pushState);
}

function loadPushFiles(hash) {
    renderPushDetail(hash);
    var head = document.getElementById('push-files-head');
    var list = document.getElementById('push-files-list');
    if (!list) {return;}
    if (pushState.filesCache[hash]) {
        renderDialogFiles(head, list, pushState.filesCache[hash], pushState);
        return;
    }
    if (head) {head.innerHTML = '<span>' + T('common.loadingFiles') + '</span>' + fileModeBtnHtml(pushState.fileViewMode);}
    list.innerHTML = '<div class="push-files-loading"><span class="spin"></span> ' + T('common.loadingFiles') + '</div>';
    if (hash === '__all__') {
        vscode.postMessage({ command: 'getPushAllFiles' });
    } else {
        vscode.postMessage({ command: 'getCommitFilesForPush', hash: hash });
    }
}

function renderPushDetail(hash) {
    var el = document.getElementById('push-commit-detail');
    if (!el) {return;}
    var commit = hash && hash !== '__all__'
        ? pushState.commits.filter(function (c) { return c.hash === hash; })[0]
        : null;
    renderDialogDetail(el, commit, pushState.commits);
}

// Handle commit files response from extension
window._handlePushFiles = function (hash, files) {
    pushState.filesCache[hash] = files;
    if (pushState.selectedHash === hash) {
        refreshPushFiles();
    }
};

/* ---- branch compare dialog (read-only) ---- */
var compareState = { commits: [], selectedHash: null, filesCache: {}, branchName: '', currentBranch: '', visibleCount: 20, fileViewMode: 'tree', collapsedDirs: {} };

function showCompareDialog(branchName, currentBranch, commits) {
    compareState = { commits: commits, selectedHash: '__all__', filesCache: {}, branchName: branchName, currentBranch: currentBranch, visibleCount: 20, fileViewMode: state.fileViewMode || 'tree', collapsedDirs: {} };
    var overlay = document.createElement('div');
    overlay.className = 'push-dialog-overlay';
    overlay.id = 'compare-dialog';

    // Aggregate row: all files differing between the two branch tips
    var allRowHtml = '<div class="push-commit-row push-all-row sel" data-hash="__all__" data-title="' + esc(T('compare.allDiffTip')) + '">' +
        '<span class="push-commit-msg push-all-label">' + T('compare.allDiff') + '</span>' +
        '</div>';

    function renderCommitBatch(startIdx, endIdx) {
        return commits.slice(startIdx, endIdx).map(function (c) {
            return dialogCommitRowHtml(c, c.hash === compareState.selectedHash);
        }).join('');
    }

    var commitRows = renderCommitBatch(0, 20);
    var loadMoreHtml = '';
    if (commits.length > 20) {
        loadMoreHtml = '<div class="push-load-more-container"><button class="push-load-more-btn">' + T('common.loadMoreCommits', { n: commits.length - 20 }) + '</button></div>';
    }

    var subtitle = commits.length > 0
        ? T('compare.unique', { n: commits.length, branch: esc(branchName) })
        : T('compare.sameCommits');
    var headerText = T('compare.title') + esc(currentBranch) + ' <span class="push-arrow">⇄</span> ' + esc(branchName) +
        ' <span class="push-compare-sub">' + subtitle + '</span>';

    overlay.innerHTML = '<div class="push-dialog-box">' +
        '<div class="push-dialog-header">' + headerText + '</div>' +
        '<div class="push-dialog-body">' +
        '<div class="push-commits-list"><div class="push-commits-scroll" id="compare-commits-scroll">' + allRowHtml + commitRows + loadMoreHtml + '</div></div>' +
        dialogSidePanelHtml({ head: 'compare-files-head', list: 'compare-files-list', detail: 'compare-commit-detail' }) +
        '</div>' +
        '<div class="push-dialog-actions">' +
        '<button class="dialog-btn secondary" data-action="close">' + T('common.close') + '</button>' +
        '</div></div>';

    document.body.appendChild(overlay);
    attachDialogResize(overlay, 'compare');

    function attachCommitClickHandlers() {
        overlay.querySelectorAll('.push-commit-row').forEach(function (row) {
            row.addEventListener('click', function () {
                overlay.querySelectorAll('.push-commit-row').forEach(function (r) { r.classList.remove('sel'); });
                row.classList.add('sel');
                compareState.selectedHash = row.getAttribute('data-hash');
                loadCompareFiles(compareState.selectedHash);
            });
        });
    }
    attachCommitClickHandlers();

    var loadMoreBtn = overlay.querySelector('.push-load-more-btn');
    if (loadMoreBtn) {
        loadMoreBtn.addEventListener('click', function () {
            var currentVisible = compareState.visibleCount || 20;
            var nextBatchEnd = Math.min(currentVisible + 20, commits.length);
            var newRows = renderCommitBatch(currentVisible, nextBatchEnd);
            var loadMoreContainer = overlay.querySelector('.push-load-more-container');
            if (loadMoreContainer) {
                var tempDiv = document.createElement('div');
                tempDiv.innerHTML = newRows;
                while (tempDiv.firstChild) {
                    loadMoreContainer.parentNode.insertBefore(tempDiv.firstChild, loadMoreContainer);
                }
            }
            compareState.visibleCount = nextBatchEnd;
            attachCommitClickHandlers();
            if (nextBatchEnd < commits.length) {
                loadMoreBtn.textContent = T('common.loadMoreCommits', { n: commits.length - nextBatchEnd });
            } else {
                loadMoreBtn.parentElement.remove();
            }
        });
    }

    overlay.querySelectorAll('.push-dialog-actions .dialog-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            overlay.remove();
            vscode.postMessage({ command: 'compareDialogClosed' });
        });
    });

    attachFilePaneHandlers(overlay, compareState, refreshCompareFiles, function (path) {
        vscode.postMessage({ command: 'compareFileDiff', hash: compareState.selectedHash || '__all__', path: path });
    });

    loadCompareFiles('__all__');
}

function refreshCompareFiles() {
    var files = compareState.filesCache[compareState.selectedHash];
    if (!files) {return;} // still loading: keep the spinner
    renderDialogFiles(document.getElementById('compare-files-head'), document.getElementById('compare-files-list'), files, compareState);
}

function loadCompareFiles(hash) {
    var el = document.getElementById('compare-commit-detail');
    var commit = hash && hash !== '__all__'
        ? compareState.commits.filter(function (c) { return c.hash === hash; })[0]
        : null;
    if (el) {renderDialogDetail(el, commit, compareState.commits);}

    var head = document.getElementById('compare-files-head');
    var list = document.getElementById('compare-files-list');
    if (!list) {return;}
    if (compareState.filesCache[hash]) {
        renderDialogFiles(head, list, compareState.filesCache[hash], compareState);
        return;
    }
    if (head) {head.innerHTML = '<span>' + T('common.loadingFiles') + '</span>' + fileModeBtnHtml(compareState.fileViewMode);}
    list.innerHTML = '<div class="push-files-loading"><span class="spin"></span> ' + T('common.loadingFiles') + '</div>';
    if (hash === '__all__') {
        vscode.postMessage({ command: 'getCompareAllFiles' });
    } else {
        vscode.postMessage({ command: 'getCompareFiles', hash: hash });
    }
}

window._handleCompareFiles = function (hash, files) {
    compareState.filesCache[hash] = files;
    if (compareState.selectedHash === hash) {
        refreshCompareFiles();
    }
};

/* ---- file history dialog (read-only: every commit touching one file) ---- */
var fileHistoryState = { commits: [], filePath: '', visibleCount: 20 };

function showFileHistoryDialog(filePath, history) {
    fileHistoryState = { commits: history, filePath: filePath, visibleCount: 20 };
    var overlay = document.createElement('div');
    overlay.className = 'push-dialog-overlay';
    overlay.id = 'file-history-dialog';

    function renderCommitBatch(startIdx, endIdx) {
        return history.slice(startIdx, endIdx).map(function (c) {
            var cleanMessage = (c.message || '').replace(/^`{1,3}\s*/, '');
            var fullInfo = c.shortHash + ' ' + cleanMessage + '\n' + c.author + ' ' + fmtDate(c.date) + ' (' + fmtRelativeTime(c.date) + ')';
            return '<div class="push-commit-row" data-hash="' + esc(c.hash) + '" data-title="' + esc(fullInfo) + '">' +
                '<span class="push-commit-hash">' + esc(c.shortHash) + '</span>' +
                '<span class="push-commit-msg">' + esc(cleanMessage) + '</span>' +
                '<span class="push-commit-author">' + esc(c.author) + '</span>' +
                '<span class="push-commit-date" data-title="' + esc(fmtDate(c.date)) + '">' + esc(fmtRelativeTime(c.date)) + '</span>' +
                '</div>';
        }).join('');
    }

    var commitRows = renderCommitBatch(0, 20);
    var loadMoreHtml = '';
    if (history.length > 20) {
        loadMoreHtml = '<div class="push-load-more-container"><button class="push-load-more-btn">' + T('common.loadMoreCommits', { n: history.length - 20 }) + '</button></div>';
    }

    var headerText = T('fileHistory.title') + ' <span class="push-compare-sub">' + esc(filePath) + '</span>';

    overlay.innerHTML = '<div class="push-dialog-box">' +
        '<div class="push-dialog-header">' + headerText + '</div>' +
        '<div class="push-dialog-body">' +
        '<div class="push-commits-list full"><div class="push-commits-scroll" id="file-history-scroll">' + commitRows + loadMoreHtml + '</div></div>' +
        '</div>' +
        '<div class="push-dialog-actions">' +
        '<span class="file-history-hint">' + T('fileHistory.dblclickHint') + '</span>' +
        '<button class="dialog-btn secondary" data-action="close">' + T('common.close') + '</button>' +
        '</div></div>';

    document.body.appendChild(overlay);
    attachDialogResize(overlay, 'fileHistory');

    // Event delegation so dynamically added (load-more) rows work without duplicate handlers
    var scroll = overlay.querySelector('#file-history-scroll');
    scroll.addEventListener('click', function (e) {
        var row = e.target.closest('.push-commit-row');
        if (!row) { return; }
        overlay.querySelectorAll('.push-commit-row').forEach(function (r) { r.classList.remove('sel'); });
        row.classList.add('sel');
    });
    scroll.addEventListener('dblclick', function (e) {
        var row = e.target.closest('.push-commit-row');
        if (!row) { return; }
        vscode.postMessage({ command: 'action', action: 'fileDiff', hash: row.getAttribute('data-hash'), path: filePath });
    });

    var loadMoreBtn = overlay.querySelector('.push-load-more-btn');
    if (loadMoreBtn) {
        loadMoreBtn.addEventListener('click', function () {
            var currentVisible = fileHistoryState.visibleCount || 20;
            var nextBatchEnd = Math.min(currentVisible + 20, history.length);
            var newRows = renderCommitBatch(currentVisible, nextBatchEnd);
            var loadMoreContainer = overlay.querySelector('.push-load-more-container');
            if (loadMoreContainer) {
                var tempDiv = document.createElement('div');
                tempDiv.innerHTML = newRows;
                while (tempDiv.firstChild) {
                    loadMoreContainer.parentNode.insertBefore(tempDiv.firstChild, loadMoreContainer);
                }
            }
            fileHistoryState.visibleCount = nextBatchEnd;
            if (nextBatchEnd < history.length) {
                loadMoreBtn.textContent = T('common.loadMoreCommits', { n: history.length - nextBatchEnd });
            } else {
                loadMoreBtn.parentElement.remove();
            }
        });
    }

    overlay.querySelectorAll('.push-dialog-actions .dialog-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            overlay.remove();
        });
    });
}

/* ---------- reflog dialog (recover lost commits) ---------- */
var reflogState = { entries: [], visibleCount: 20 };

function showReflogDialog(scope, entries) {
    reflogState = { entries: entries, visibleCount: 20 };

    function row(entry) {
        var tip = entry.shortHash + '\n' +
            entry.action + (entry.message ? ': ' + entry.message : '') + '\n' +
            fmtDateTime(entry.date) + ' (' + fmtRelativeTime(entry.date) + ')';
        return '<div class="push-commit-row reflog-row" data-hash="' + esc(entry.hash) + '" data-title="' + esc(tip) + '">' +
            '<span class="push-commit-hash">' + esc(entry.shortHash) + '</span>' +
            '<span class="push-commit-msg">' + esc(entry.message || entry.action) + '</span>' +
            '<span class="push-commit-author">' + esc(entry.action) + '</span>' +
            '<span class="push-commit-date" data-title="' + esc(fmtDateTime(entry.date)) + '">' + esc(fmtRelativeTime(entry.date)) + '</span>' +
            '</div>';
    }

    var overlay = document.createElement('div');
    overlay.className = 'push-dialog-overlay';
    overlay.id = 'reflog-dialog';
    var visible = entries.slice(0, reflogState.visibleCount);
    var moreHtml = entries.length > visible.length
        ? '<div class="push-load-more-container"><button class="push-load-more-btn">' + T('common.loadMoreCommits', { n: entries.length - visible.length }) + '</button></div>'
        : '';

    overlay.innerHTML = '<div class="push-dialog-box">' +
        '<div class="push-dialog-header">' + T('reflog.title') + ' <span class="push-compare-sub">' + esc(scope) + '</span></div>' +
        '<div class="push-dialog-body">' +
        '<div class="push-commits-list full"><div class="push-commits-scroll" id="reflog-scroll">' +
        visible.map(row).join('') + moreHtml +
        '</div></div>' +
        '</div>' +
        '<div class="push-dialog-actions">' +
        '<span class="file-history-hint">' + T('reflog.hint') + '</span>' +
        '<button class="dialog-btn secondary" data-action="close">' + T('common.close') + '</button>' +
        '</div></div>';

    document.body.appendChild(overlay);
    attachDialogResize(overlay, 'reflog');

    var scroll = overlay.querySelector('#reflog-scroll');
    // Delegation: appended batches need handlers too, and the picked row must be
    // usable after the list grows.
    scroll.addEventListener('click', function (e) {
        var more = e.target.closest('.push-load-more-btn');
        if (more) {
            var next = Math.min(reflogState.visibleCount + 20, entries.length);
            var container = more.parentElement;
            var frag = document.createElement('div');
            frag.innerHTML = entries.slice(reflogState.visibleCount, next).map(row).join('');
            while (frag.firstChild) { container.parentNode.insertBefore(frag.firstChild, container); }
            reflogState.visibleCount = next;
            if (next < entries.length) {
                more.textContent = T('common.loadMoreCommits', { n: entries.length - next });
            } else {
                container.remove();
            }
            return;
        }
        var picked = e.target.closest('.push-commit-row');
        if (!picked) { return; }
        overlay.querySelectorAll('.push-commit-row').forEach(function (r) { r.classList.remove('sel'); });
        picked.classList.add('sel');
    });
    scroll.addEventListener('dblclick', function (e) {
        var picked = e.target.closest('.push-commit-row');
        if (!picked) { return; }
        vscode.postMessage({ command: 'action', action: 'showDiff', hash: picked.getAttribute('data-hash') });
        overlay.remove();
    });
    scroll.addEventListener('contextmenu', function (e) {
        var picked = e.target.closest('.push-commit-row');
        if (!picked) { return; }
        e.preventDefault();
        if (window._hideTooltip) window._hideTooltip();
        var hash = picked.getAttribute('data-hash');
        // Every entry is a way out of a mistake, in the order the user needs them:
        // first find out what happened, then either keep it or undo it.
        var items = [
            ['showDiff', T('reflog.menu.checkWhat')],
            ['newBranchFrom', T('reflog.menu.keepOnBranch')],
            ['reset', T('reflog.menu.undoToHere')],
            ['cherryPick', T('reflog.menu.pickBack')],
            ['copy', T('menu.copyHash')]
        ];
        showMenu(e.clientX, e.clientY, items, function (action) {
            if (action === 'copy') {
                navigator.clipboard.writeText(hash);
                return;
            }
            vscode.postMessage({ command: 'action', action: action, hash: hash });
            overlay.remove();
        });
    });

    overlay.querySelectorAll('.push-dialog-actions .dialog-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            overlay.remove();
        });
    });
}

/* ---------- operation status indicator ---------- */
// Operation status bar button event delegation (bind once, handle all clicks)
(function initOperationButtons() {
    var statusEl = document.getElementById('operation-status');
    if (!statusEl) return;
    
    statusEl.addEventListener('click', function(e) {
        if (e.target.id === 'btn-continue-op') {
            vscode.postMessage({ command: 'action', action: 'continueOperation' });
        } else if (e.target.id === 'btn-abort-op') {
            vscode.postMessage({ command: 'action', action: 'abortOperation' });
        }
    });
})();

function renderOperationStatus() {
    var statusEl = document.getElementById('operation-status');
    var textEl = document.getElementById('operation-status-text');
    
    // If DOM elements don't exist yet, retry after a short delay
    if (!statusEl || !textEl) {
        setTimeout(renderOperationStatus, 50);
        return;
    }
    
    // Ensure action buttons container exists (create once if not present)
    var actionsEl = statusEl.querySelector('.operation-actions');
    if (!actionsEl) {
        actionsEl = document.createElement('div');
        actionsEl.className = 'operation-actions';
        statusEl.appendChild(actionsEl);
    }

    if (!state.inProgress) {
        // Operation completed - hide status bar and clear buttons
        statusEl.style.display = 'none';
        actionsEl.innerHTML = '';
        return;
    }

    var opLabel = '';
    if (state.inProgress === 'rebase') opLabel = T('op.rebaseInProgress');
    else if (state.inProgress === 'merge') opLabel = T('op.mergeInProgress');
    else if (state.inProgress === 'cherry-pick') opLabel = T('op.cherryPickInProgress');
    else if (state.inProgress === 'revert') opLabel = T('op.revertInProgress');

    textEl.textContent = opLabel;

    // Every kind is continued/aborted through the same two buttons; the host
    // chooses the matching git subcommand from the detected operation.
    actionsEl.innerHTML = '<button id="btn-continue-op" class="op-btn continue">' + T('op.continue') + '</button>' +
                          '<button id="btn-abort-op" class="op-btn abort">' + T('op.abort') + '</button>';
    
    statusEl.style.display = 'flex';
}

// Custom tooltip system for theme-aware hover hints
(function initCustomTooltip() {
    var tooltip = null;
    var tooltipTimer = null;
    
    function createTooltip() {
        if (!tooltip) {
            tooltip = document.createElement('div');
            tooltip.className = 'custom-tooltip';
            document.body.appendChild(tooltip);
        }
        return tooltip;
    }
    
    function showTooltip(text, x, y) {
        if (!text) return;
        
        var tip = createTooltip();
        tip.textContent = text;
        tip.style.left = (x + 10) + 'px';
        tip.style.top = (y + 10) + 'px';
        
        // Adjust position if tooltip goes off screen
        setTimeout(function() {
            var rect = tip.getBoundingClientRect();
            if (rect.right > window.innerWidth) {
                tip.style.left = (x - rect.width - 10) + 'px';
            }
            if (rect.bottom > window.innerHeight) {
                tip.style.top = (y - rect.height - 10) + 'px';
            }
        }, 0);
        
        tip.classList.add('visible');
    }
    
    function hideTooltip() {
        if (tooltip) {
            tooltip.classList.remove('visible');
        }
        if (tooltipTimer) {
            clearTimeout(tooltipTimer);
            tooltipTimer = null;
        }
    }
    
    // Expose hideTooltip globally so context menus can call it
    window._hideTooltip = hideTooltip;
    
    // Attach tooltip to elements with data-title attribute (not native title)
    document.addEventListener('mouseover', function(e) {
        var target = e.target;
        if (target && target.getAttribute && target.getAttribute('data-title')) {
            var title = target.getAttribute('data-title');
            if (title) {
                tooltipTimer = setTimeout(function() {
                    showTooltip(title, e.clientX, e.clientY);
                }, 300); // Show after 300ms delay
            }
        }
    });
    
    document.addEventListener('mouseout', function(e) {
        hideTooltip();
    });
    
    document.addEventListener('mousemove', function(e) {
        if (tooltip && tooltip.classList.contains('visible')) {
            tooltip.style.left = (e.clientX + 10) + 'px';
            tooltip.style.top = (e.clientY + 10) + 'px';
        }
    });
})();

initPaneFocus();
renderOperationStatus();
renderTree();
renderRows();
renderDetail();
vscode.postMessage({ command: 'ready' });
