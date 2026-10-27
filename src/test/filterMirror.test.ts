import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The applied commit-list filter lives in the host (`_filters`); the boxes that
 * show it live in a DOM that is destroyed on every panel hide. Without an echo
 * back down, a re-show paints empty boxes above a list still narrowed by the last
 * search — and the refresh button then re-applies a term the user cannot see,
 * which is what makes the search box look like it stopped working.
 */

// out/test -> repository root
const ROOT = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(path.join(ROOT, 'src', 'views', 'graphView.ts'), 'utf8');
const webview = fs.readFileSync(path.join(ROOT, 'media', 'webview.js'), 'utf8');

describe('applied list filter stays visible', () => {
    it('the filter echo is a screen message', () => {
        const screen = source.match(/const SCREEN_COMMANDS[\s\S]*?\]\);/);
        assert.ok(screen, 'SCREEN_COMMANDS must exist');
        assert.ok(
            /'syncFilters'/.test(screen[0]),
            "syncFilters must be buffered until the 'ready' handshake — posted into a frame that is still booting it is dropped, and that is the bug this message exists to fix"
        );
    });

    it('every commit-list paint echoes the filter it used', () => {
        const collect = source.match(/private async _collect\([\s\S]*?\n {4}\}/);
        const background = source.match(/private async _loadAndDisplayCommits\([\s\S]*?\n {4}\}/);
        assert.ok(collect && background, 'both list painters must exist');
        assert.ok(
            /_postFilterMirror\(\)/.test(collect[0]),
            '_collect feeds setData, so it must echo _filters too — otherwise a search outlives its own box'
        );
        assert.ok(
            /_postFilterMirror\(\)/.test(background[0]),
            '_loadAndDisplayCommits runs the same filtered query and paints setCommits'
        );
    });

    it('the panel fills an empty box from the echo but never rewrites a draft', () => {
        const fill = webview.match(/function fillFilterBox\(inputId, clrId, value\) \{[\s\S]*?\n\}/);
        assert.ok(fill, 'webview.js must guard the box mirror in one place');
        assert.ok(
            /el\.value \|\|/.test(fill[0]),
            'a box that already holds text is an un-applied draft: the echo may fill it, never overwrite or clear it'
        );
    });

    it('emptying a filter box clears the host filter right away', () => {
        const watch = webview.match(/'f-search\|clr-search\|text'[\s\S]*?\n\}\);/);
        assert.ok(watch, 'the filter boxes must register the watcher that mirrors the ✕ button');
        assert.ok(
            /appliedFilters\[ids\[2\]\][\s\S]*?pushFilters\(\)/.test(watch[0]),
            'backspacing the last character is an unambiguous clear; waiting for Enter leaves the list filtered by nothing the box shows'
        );
    });

    it('the two search switches ride along with the text filter', () => {
        const push = webview.match(/function pushFilters\(\) \{[\s\S]*?\n\}/);
        assert.ok(push, 'pushFilters must exist');
        assert.ok(
            /command: 'setFilters'[\s\S]*?regex: searchMode\.regex[\s\S]*?caseSensitive: searchMode\.caseSensitive/.test(push[0]),
            'the .* / Cc switches are part of the query: a box that lights up without sending them shows a mode the list is not using'
        );
        const mirror = webview.match(/function applyFilterMirror\(m\) \{[\s\S]*?\n\}/);
        assert.ok(mirror, 'applyFilterMirror must exist');
        assert.ok(
            /searchMode\.regex = !!f\.regex/.test(mirror[0]) && /searchMode\.caseSensitive = !!f\.caseSensitive/.test(mirror[0]),
            'a mode is not a draft: the echo must set both switches, or a re-shown panel offers the opposite of what it searched with'
        );
        const store = source.match(/case 'setFilters':[\s\S]*?this\._filters = \{[\s\S]*?\};/);
        assert.ok(store, "the 'setFilters' handler must exist");
        assert.ok(
            /regex: !!message\.regex/.test(store[0]) && /caseSensitive: !!message\.caseSensitive/.test(store[0]),
            'the host is the owner of the applied filter, so it has to hold the switches too'
        );
    });
});

describe('git search honours the .* and Cc switches', () => {
    const gitService = fs.readFileSync(path.join(ROOT, 'src', 'services', 'gitService.ts'), 'utf8');

    it('literal by default, extended regex on request, case folding by default', () => {
        const branch = gitService.match(/if \(searchText && !forHash\) \{[\s\S]*?\n {12}\}/);
        assert.ok(branch, 'the grep branch of the log arguments must exist');
        assert.ok(
            /f\.regex \? '-E' : '-F'/.test(branch[0]),
            '-F keeps substring matching while stopping ( . * from being syntax; -E is what the switch asks for'
        );
        assert.ok(
            /if \(!f\.caseSensitive\) \{a\.push\('-i'\);\}/.test(branch[0]),
            'case folding must be the default and must disappear when the user asks for Cc'
        );
    });

    it('the graph cache knows which switches produced an entry', () => {
        const key = gitService.match(/const key = `\$\{this\._repositoryPath \?\? ''\}\|\$\{opts\.branch[\s\S]*?`;/);
        assert.ok(key, 'the graph cache key must exist');
        assert.ok(
            /f\.regex[\s\S]*f\.caseSensitive/.test(key[0]),
            'the same words searched two ways are two different answers — a cache that ignores the switches serves the wrong list'
        );
    });
});
