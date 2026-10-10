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

/**
 * Check if a ref name looks like a tag (common conventions)
 * Tags are usually short names without slashes, or match patterns like v1.0.0, release-*, etc.
 */
function isTagName(name) {
    // Common tag patterns: v1.0.0, 1.0.0, release-*, etc.
    // Also check if it's in refs/tags/ namespace (would come from git as just the name)
    return /^v?\d+\.\d+/.test(name) || 
           /^(release|tag)[-_]/i.test(name) ||
           /^[A-Z][a-z]+-\d/.test(name); // e.g., "Version-1"
}

var state = {
    commits: INITIAL.commits || [],
    local: INITIAL.local || [],
    remote: INITIAL.remote || [],
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
    highlight: '',
    selectedHash: null,
    selectedHashes: [], // Multi-select support
    lastClickedIndex: -1, // For Shift+click range selection
    detail: null,
    collapsed: {},
    collapsedSec: {},
    expandedFolder: {},
    fileViewMode: 'tree',
    graphVisible: true,
    graphOverflow: false,
    repoState: 'ready',
    repoFolder: '',
    repoPendingFiles: 0,
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

    function setupV(resizerId, targetId, minH) {
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
                st['filesHeight'] = target.offsetHeight;
                vscode.setState(st);
            }
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }

    setup('resizer-left', 'left', 120, false);
    setup('resizer-right', 'right', 180, true);
    setupV('resizer-info', 'd-files', 60);
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
function esc(t) {
    var d = document.createElement('div');
    d.textContent = t == null ? '' : String(t);
    return d.innerHTML;
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
var I_CLOUD = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4.5 12a3 3 0 0 1 0-6 4 4 0 0 1 7.5 1 2.5 2.5 0 0 1-.5 5z"/></svg>';
var I_FOLDER = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1 4h5l2 2h7v8H1V4z"/></svg>';
var I_FILE = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3.5 1.5h6l3 3v10h-9z"/></svg>';
// VSCode-explorer-style chevrons (theme-aware via currentColor)
var I_CARET_R = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>';
var I_CARET_D = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>';
// File list mode switch icons: indented tree vs. flat rows (theme-aware via currentColor)
var I_TREE_MODE = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M2 3h4"/><path d="M6 6.5h4"/><path d="M6 12.5h4"/><path d="M2 9.5h4"/><path d="M4 3v9.5"/></svg>';
var I_FLAT_MODE = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M2 3.5h12"/><path d="M2 8h12"/><path d="M2 12.5h12"/></svg>';

/* ---------- left branch tree ---------- */
function renderTree() {
    // Show skeleton on initial load if branches not loaded yet
    if (loadState.initialLoad && !loadState.branchesLoaded) {
        document.getElementById('btree').innerHTML = renderBranchSkeleton();
        return;
    }
    
    var q = state.bfilter.toLowerCase();
    function match(n) { return !q || n.toLowerCase().indexOf(q) >= 0; }
    function item(n, icon, depth, label) {
        var cls = 'bitem' + (n === state.selectedBranch ? ' sel' : '') + (n === state.current ? ' cur' : '') + (n === state.highlight ? ' hl' : '');
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
        
        return '<div class="' + cls + '" data-branch="' + esc(n) + '" data-title="' + esc(tooltipText) + '" style="padding-left:' + (20 + depth * 12) + 'px">' + icon + '<span class="bname">' + esc(displayName) + '</span>' + arrows + '</div>';
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
            if (q && cnt === 0) return;
            var expanded = !!q || !!state.expandedFolder[p];
            var folderCaret = expanded ? I_CARET_D : I_CARET_R;
            out.push('<div class="bfolder" data-folder="' + esc(p) + '" style="padding-left:' + (8 + depth * 16) + 'px">' +
                '<span class="caret">' + folderCaret + '</span>' + I_FOLDER +
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
        return '<div class="bsec" data-sec="' + key + '">' + caret + I_FOLDER + '<span>' + esc(title) + '</span>' + cnt + '</div>';
    }
    function section(key, title, list, icon) {
        var total = list.filter(match).length;
        var s = header(key, title, total);
        if (!state.collapsedSec[key]) {
            var out = [];
            renderNode(build(list), '', 0, icon, out);
            s += out.join('');
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
        head = header('head', T('w.headSection')) + (state.collapsedSec['head'] ? '' : item(state.current, I_BRANCH, 0) + resumeHtml);
    }
    document.getElementById('btree').innerHTML =
        '<div id="btree-inner">' + head +
        section('local', T('common.local'), state.local, I_BRANCH) +
        section('remote', T('common.remote'), state.remote, I_CLOUD) + '</div>';
}

/* ---------- center commit list ---------- */
function renderRows() {
    var list = state.commits;
    if (list.length === 0) {
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

    // Build HTML rows (without dots)
    var html = '';
    list.forEach(function (c, i) {
        var chips = '';
        (c.refs || []).forEach(function (r) {
            if (r === 'HEAD') return;
            
            // Determine ref type for styling
            var isBranch = !r.includes('/') && !isTagName(r);
            var isRemote = r.indexOf('origin/') === 0 || r.indexOf('remotes/') === 0;
            var isTag = isTagName(r);
            
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
    });

    var wrap = document.getElementById('rows');
    wrap.innerHTML = html;
    wrap.style.minWidth = (graphW + 500) + 'px';

    // Detect overflow in .refs containers and add fade-out gradient
    var refsContainers = wrap.querySelectorAll('.refs');
    for (var i = 0; i < refsContainers.length; i++) {
        var refs = refsContainers[i];
        if (refs.scrollWidth > refs.clientWidth) {
            refs.classList.add('has-overflow');
        }
    }

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

/**
 * Render details for multiple selected commits (merged view)
 */
function renderMultiCommitDetail(info, filesBox) {
    var commits = state.multiCommits || [];
    
    // Show commit count header
    var header = '<div class="multi-select-header">';
    header += '<span class="multi-count">' + T('common.commitCount', { n: commits.length }) + '</span>';
    header += '</div>';
    
    // Show all commit messages in chronological order (oldest first)
    var sorted = commits.slice().reverse(); // Reverse to show oldest first
    var msgHtml = '<div class="multi-commit-list">';
    sorted.forEach(function(c) {
        msgHtml += '<div class="multi-commit-item" data-hash="' + esc(c.hash) + '">';
        msgHtml += '<span class="hashchip">' + esc(c.shortHash) + '</span>';
        msgHtml += '<span class="cmsg">' + esc(c.message || T('commit.noMessage')) + '</span>';
        msgHtml += '<span class="cmeta">' + esc(c.author) + ' · ' + esc(fmtRelativeTime(c.date)) + '</span>';
        msgHtml += '</div>';
    });
    msgHtml += '</div>';
    
    info.innerHTML = header + msgHtml;
    
    // Show merged files (deduplicated)
    var allFiles = state.multiFiles || [];
    var fileMap = {};
    allFiles.forEach(function(f) {
        if (!fileMap[f.path]) {
            fileMap[f.path] = { path: f.path, added: 0, deleted: 0, status: f.status };
        }
        fileMap[f.path].added += f.added || 0;
        fileMap[f.path].deleted += f.deleted || 0;
    });
    var mergedFiles = Object.values(fileMap);
    
    if (mergedFiles.length === 0) {
        filesBox.innerHTML = '<div class="empty">' + T('common.noFileChanges') + '</div>';
        return;
    }
    
    // Build file tree
    var mode = state.fileViewMode || FILE_MODE_TREE;
    var fh = fileHeadHtml(mergedFiles.length, mode);
    fh += buildFileRows(mergedFiles, mode, state.collapsed, detailFileRowHtml);

    filesBox.innerHTML = '<div id="d-files-inner">' + fh + '</div>';
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

function renderDetail() {
    applyDetailVisibility();
    document.getElementById('repo-name').textContent = state.repoName;
    var info = document.getElementById('d-info');
    var filesBox = document.getElementById('d-files');
    
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
}

/** One row of the detail panel's file list, in either display mode. */
function detailFileRowHtml(r) {
    var pad = fileRowPad(r.depth);
    if (r.kind === 'dir') {
        return '<div class="frow dir" data-path="' + esc(r.path) + '" style="' + pad + '"><span class="caret">' + (r.closed ? I_CARET_R : I_CARET_D) + '</span>' + I_FOLDER + '<span class="fname" data-title="' + esc(r.path) + '">' + esc(r.name) + '</span><span class="fcount">' + r.count + '</span></div>';
    }
    var f = r.file;
    return '<div class="frow file" data-path="' + esc(f.path) + '" style="' + pad + '"><span class="caret"></span><span class="st-' + esc(f.status) + '">' + I_FILE + '</span><span class="fname" data-title="' + esc(f.path) + '">' + esc(r.name) + '</span>' +
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

/* ---------- events ---------- */
function pushFilters() {
    var fromDate = document.getElementById('f-from').value;
    var toDate = document.getElementById('f-to').value;
    
    // Convert date format to include time for better git filtering
    // YYYY-MM-DD -> YYYY-MM-DDT00:00:00 (start of day)
    // YYYY-MM-DD -> YYYY-MM-DDT23:59:59 (end of day)
    var fromFormatted = fromDate ? fromDate + 'T00:00:00' : '';
    var toFormatted = toDate ? toDate + 'T23:59:59' : '';
    
    vscode.postMessage({
        command: 'setFilters',
        text: document.getElementById('f-search').value,
        author: document.getElementById('f-author').value,
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

// Date inputs: change event for validation and auto-focus, Enter key for search
document.getElementById('f-from').addEventListener('change', function() {
    syncDateClr();
    
    // Auto-focus to-date input after selecting from-date
    var toDateInput = document.getElementById('f-to');
    if (toDateInput) {
        setTimeout(function() {
            toDateInput.focus();
        }, 100);
    }
    
    // Set min attribute on to-date to enforce from <= to
    var fromDate = this.value;
    if (fromDate && toDateInput) {
        toDateInput.setAttribute('min', fromDate);
        
        // Clear to-date if it's before from-date
        var toDate = toDateInput.value;
        if (toDate && toDate < fromDate) {
            toDateInput.value = '';
        }
    }
    
    // Don't auto-search on date change, only on Enter key
});

document.getElementById('f-to').addEventListener('change', function() {
    syncDateClr();
    
    // Validate that to-date is not before from-date
    var fromDate = document.getElementById('f-from').value;
    var toDate = this.value;
    
    if (fromDate && toDate && toDate < fromDate) {
        // Show warning and clear the invalid date
        vscode.postMessage({
            command: 'showNotification',
            type: 'warning',
            message: T('w.endBeforeStart')
        });
        this.value = '';
    }
    
    // Don't auto-search on date change, only on Enter key
});

// Add Enter key listener for date inputs
document.getElementById('f-from').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
        pushFilters();
    }
});

document.getElementById('f-to').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
        pushFilters();
    }
});
document.getElementById('btn-refresh').addEventListener('click', function () {
    vscode.postMessage({ command: 'refresh' });
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
['f-search|clr-search', 'f-author|clr-author', 'f-bfilter|clr-bfilter'].forEach(function (pair) {
    var ids = pair.split('|');
    syncClr(ids[0], ids[1]);
    var i = document.getElementById(ids[0]);
    if (i) i.addEventListener('input', function () { syncClr(ids[0], ids[1]); });
});
function syncDateClr() {
    var f = document.getElementById('f-from').value || document.getElementById('f-to').value;
    document.getElementById('clr-date').style.display = f ? '' : 'none';
}
syncDateClr();
document.getElementById('f-from').addEventListener('change', syncDateClr);
document.getElementById('f-to').addEventListener('change', syncDateClr);

document.getElementById('clr-search').addEventListener('click', function () {
    document.getElementById('f-search').value = '';
    syncClr('f-search', 'clr-search'); pushFilters();
});
document.getElementById('clr-author').addEventListener('click', function () {
    document.getElementById('f-author').value = '';
    syncClr('f-author', 'clr-author'); pushFilters();
});
document.getElementById('clr-date').addEventListener('click', function () {
    document.getElementById('f-from').value = '';
    document.getElementById('f-to').value = '';
    syncDateClr(); pushFilters();
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
    var item = e.target.closest('.bitem');
    if (!item) return;
    var name = item.getAttribute('data-branch');
    state.selectedBranch = name;
    state.highlight = name;
    state.detail = null;
    renderTree();
    renderDetail();
    saveViewState();
    vscode.postMessage({ command: 'selectBranch', branch: name });
});

document.getElementById('rf-branch').addEventListener('click', function () {
    vscode.postMessage({ command: 'refreshBranches' });
});

document.getElementById('tg-files').addEventListener('click', function () {
    state.detailVisible = !state.detailVisible;
    applyDetailVisibility();
    saveViewState();
});

document.getElementById('rf-files').addEventListener('click', function () {
    if (state.selectedHash) {
        vscode.postMessage({ command: 'refreshFiles', hash: state.selectedHash });
    }
});

document.getElementById('btree').addEventListener('contextmenu', function (e) {
    var item = e.target.closest('.bitem');
    if (!item) return;
    e.preventDefault();
    
    // Hide any visible tooltip when showing context menu
    if (window._hideTooltip) window._hideTooltip();
    
    var branch = item.getAttribute('data-branch');
    
    var isRemote = state.remote.indexOf(branch) >= 0;
    var isCurrent = branch === state.current;
    
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
            ['rename', T('menu.rename')]
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
            ['compareBranch', T('menu.compareWithCurrent')],
            ['rename', T('menu.rename')],
            ['deleteBranch', T('menu.deleteBranch')]
        ];
    }
    
    showMenu(e.clientX, e.clientY, menuItems, function (action) {
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
    
    // Update UI
    applyRowSelection();
    
    // Load merged files and details for multi-select or single select
    if (state.selectedHashes.length > 0) {
        state.detail = null;
        state.multiCommits = null; // Clear old multi-commit data
        state.multiFiles = null;
        state.detailVisible = true;
        
        // Show loading state immediately
        var info = document.getElementById('d-info');
        var filesBox = document.getElementById('d-files');
        info.innerHTML = '<div class="empty">' + T('ui.loading') + '</div>';
        filesBox.innerHTML = '<div class="empty">' + T('common.loadingFiles') + '</div>';
        
        saveViewState();
        
        // Send to extension (works for both single and multi-select)
        vscode.postMessage({ 
            command: 'selectCommits', 
            hashes: state.selectedHashes 
        });
    } else {
        // No selection - clear states
        state.multiCommits = null;
        state.multiFiles = null;
        state.detail = null;
        renderDetail();
    }
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
        // Multi-select mode: allow cherry-pick, drop, and squash
        items = [
            ['cherryPick', T('menu.cherryPick') + ' (' + state.selectedHashes.length + ')'],
            ['dropCommit', T('menu.dropCommit') + ' (' + state.selectedHashes.length + ')'],
            ['squashCommits', T('menu.squashCommits') + ' (' + state.selectedHashes.length + ')']
        ];
    } else {
        // Single-select mode: show all options
        items = [
            ['showDiff', T('menu.showDiff')],
            ['cherryPick', T('menu.cherryPick')],
            ['reset', T('menu.reset')]
        ];
        if (isHead) {
            items.push(['editMessage', T('menu.editMessage')]);
            items.push(['dropCommit', T('menu.dropCommit')]);
        }
        items.push(['newBranchFrom', T('menu.newBranchFrom')]);
    }
    items.push(['copy', T('menu.copyHash')]);
    
    showMenu(e.clientX, e.clientY, items, function (action) {
        if (action === 'copy') {
            navigator.clipboard.writeText(state.selectedHashes.length > 1 ? state.selectedHashes.join('\n') : hash);
        } else {
            vscode.postMessage({ 
                command: 'action', 
                action: action, 
                hash: hash,
                hashes: state.selectedHashes.length > 1 ? state.selectedHashes : undefined
            });
        }
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
});

// Double-click a file in the detail panel to open its commit diff (was single-click)
document.getElementById('d-files').addEventListener('dblclick', function (e) {
    var file = e.target.closest('.frow.file');
    if (file && state.selectedHash) {
        vscode.postMessage({ command: 'action', action: 'fileDiff', hash: state.selectedHash, path: file.getAttribute('data-path') });
    }
});

// Right-click a file in the detail panel: compare against local working tree / cherry-pick the file
document.getElementById('d-files').addEventListener('contextmenu', function (e) {
    var file = e.target.closest('.frow.file');
    if (!file || !state.selectedHash) { return; }
    e.preventDefault();
    if (window._hideTooltip) window._hideTooltip();
    var path = file.getAttribute('data-path');
    var items = [
        ['fileCompareLocal', T('menu.fileCompareLocal')],
        ['fileCherryPick', T('menu.fileCherryPick')]
    ];
    showMenu(e.clientX, e.clientY, items, function (action) {
        vscode.postMessage({ command: 'action', action: action, hash: state.selectedHash, path: path });
    });
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
    box.className = 'on ' + state.repoState;
    box.innerHTML = '<div class="rs-card">' +
        '<div class="rs-icon">' + (REPO_ICONS[state.repoState] || '') + '</div>' +
        '<div class="rs-title">' + esc(copy.title) + '</div>' +
        '<div class="rs-body">' + esc(copy.body) + '</div>' +
        '<div class="rs-actions">' + btns + '</div>' +
        '</div>';
}

var repoStateBox = document.getElementById('repo-state');
if (repoStateBox) {
    repoStateBox.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-repo-action]');
        if (!btn) { return; }
        vscode.postMessage({ command: btn.getAttribute('data-repo-action') });
    });
}

window.addEventListener('message', function (ev) {
    var m = ev.data;
    if (m.command === 'setRepoState') {
        state.repoState = m.state || 'ready';
        state.repoPendingFiles = typeof m.files === 'number' ? m.files : 0;
        state.repoFolder = m.folder || '';
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
        state.selectedHash = null;
        state.selectedHashes = []; // Clear multi-select on full data refresh
        state.lastClickedIndex = -1;
        state.multiCommits = null;
        state.multiFiles = null;
        state.detail = null;
        
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
        state.collapsed = {};
        state.collapsedSec = {};
        setLoader(false);
        document.getElementById('scroll').scrollTop = 0;
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
        renderRows();
    } else if (m.command === 'setDetail') {
        state.detail = { commit: m.commit, files: m.files };
        renderDetail();
    } else if (m.command === 'setCurrentBranch') {
        state.current = m.branch;
        renderTree();
    } else if (m.command === 'revealCommit') {
        state.selectedHash = m.hash;
        state.detailVisible = true;
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
        if (m.currentBranch) {
            state.current = m.currentBranch;
        }
        
        // Mark branches as loaded and hide skeleton
        loadState.branchesLoaded = true;
        if (loadState.initialLoad && loadState.commitsLoaded) {
            loadState.initialLoad = false;
            hideInitialLoading();
        }
        
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
        showPushDialog(m.branchName, m.commits || [], m.remoteExists, m.isFirstPush);
    } else if (m.command === 'pushFilesResponse') {
        window._handlePushFiles(m.hash, m.files || []);
    } else if (m.command === 'showCompareDialog') {
        showCompareDialog(m.branchName, m.currentBranch, m.commits || []);
    } else if (m.command === 'compareFilesResponse') {
        window._handleCompareFiles(m.hash, m.files || []);
    } else if (m.command === 'showFileHistory') {
        showFileHistoryDialog(m.filePath, m.history || []);
    } else if (m.command === 'multiCommitsResponse') {
        // Handle multi-select commits response
        state.multiCommits = m.commits || [];
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
        return '<div class="push-file-row dir" data-path="' + esc(r.path) + '" style="' + pad + '"><span class="caret">' + (r.closed ? I_CARET_R : I_CARET_D) + '</span>' + I_FOLDER + '<span class="push-file-name" data-title="' + esc(r.path) + '">' + esc(r.name) + '</span><span class="fcount">' + r.count + '</span></div>';
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

function showPushDialog(branchName, commits, remoteExists, isFirstPush) {
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
    if (commits.length === 0 && (isFirstPush || !pushState.remoteExists)) {
        emptyStateHtml = '<div class="push-empty-state">' +
            '<div class="push-empty-icon">📦</div>' +
            '<div class="push-empty-text">' + T('pushDlg.firstPushText') + '</div>' +
            '<div class="push-empty-hint">' + T('pushDlg.firstPushHint') + '</div>' +
            '</div>';
    }

    // Add "Load More" button if there are more than 20 commits
    var loadMoreHtml = '';
    if (commits.length > 20) {
        var remainingCount = Math.min(20, commits.length - 20);
        loadMoreHtml = '<div class="push-load-more-container"><button class="push-load-more-btn">' + T('common.loadMoreCommits', { n: commits.length - 20 }) + '</button></div>';
    }

    var remoteLabel = pushState.remoteExists ? 'origin/' + esc(branchName) : 'origin/' + esc(branchName) + ' <span class="push-new-badge">(new)</span>';
    var commitCountText = commits.length > 0 ? T('common.commitCount', { n: commits.length }) : (pushState.remoteExists ? T('pushDlg.upToDate') : T('pushDlg.firstPush'));
    var headerText = esc(branchName) + ' <span class="push-arrow">→</span> ' + remoteLabel + ' — ' + commitCountText;

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

    textEl.textContent = opLabel;

    // Update buttons based on operation type
    if (state.inProgress === 'merge' || state.inProgress === 'rebase' || state.inProgress === 'cherry-pick') {
        actionsEl.innerHTML = '<button id="btn-continue-op" class="op-btn continue">' + T('op.continue') + '</button>' +
                              '<button id="btn-abort-op" class="op-btn abort">' + T('op.abort') + '</button>';
    } else {
        actionsEl.innerHTML = '';
    }
    
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

renderOperationStatus();
renderTree();
renderRows();
renderDetail();
vscode.postMessage({ command: 'ready' });
