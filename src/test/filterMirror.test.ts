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
});
