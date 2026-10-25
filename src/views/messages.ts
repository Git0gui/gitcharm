import { GraphCommit, CommitDetail, FileStat, StashEntry, ReflogEntry, RepositoryOption, WorktreeEntry } from '../services/gitService';
import { FileIconPack } from '../services/fileIconTheme';
import { DiffPreviewLine } from '../services/gitUtils';

/**
 * Message protocol between the extension host and the graph webview.
 * Both sides must only send messages from these unions; the webview side
 * (media/webview.js) mirrors these shapes by convention — keep them in sync.
 */

export type OperationKind = 'rebase' | 'merge' | 'cherry-pick' | 'revert';

/**
 * What the panel can meaningfully show right now. Anything other than 'ready'
 * replaces the commit list with guidance instead of running commands that fail.
 * - noGit: the git binary could not be spawned
 * - noRepo: git works, but the workspace is not a repository
 * - emptyRepo: repository exists but has no commits yet
 */
export type RepoUiState = 'ready' | 'noGit' | 'noRepo' | 'emptyRepo';

export interface DivergenceEntry {
    ahead: number;
    behind: number;
    upstream?: string;
}

/** Panel view state persisted across webview recreations (workspaceState). */
export interface PersistedViewState {
    branch?: string;
    selectedHash?: string;
    scrollTop?: number;
    detailVisible?: boolean;
    collapsed?: Record<string, boolean>;
    collapsedSec?: Record<string, boolean>;
    expandedFolder?: Record<string, boolean>;
    /** 'tree' (default) or 'flat' — how the detail panel lists changed files. */
    fileViewMode?: 'tree' | 'flat';
    /** false hides the commit graph column entirely (useful in branch-heavy repos). */
    graphVisible?: boolean;
    /** Epoch ms stamped by the host when the snapshot is flushed; drives the session-restore TTL window. */
    savedAt?: number;
    /**
     * Repository the snapshot was taken in, stamped by the host. A mismatch means
     * it belongs to another root of a multi-folder workspace and must not be
     * replayed there — branch names and hashes collide between projects.
     */
    repoPath?: string;
}

export interface PushDialogCommit {
    hash: string;
    shortHash: string;
    message: string;
    author: string;
    date: string;
}

/** Messages sent from the extension host to the webview. */
export type ExtToWebviewMessage =
    | {
        command: 'setData';
        commits: GraphCommit[];
        local: string[];
        remote: string[];
        currentBranch: string;
        selectedBranch: string;
        repoName: string;
        hasMore: boolean;
        /** Rows exist above a revealed commit but are not loaded yet. */
        hasMoreAbove?: boolean;
        headHash: string;
        inProgress?: OperationKind;
        favorites?: string[];
        recent?: string[];
        /** External history change: re-render rows without clearing what is selected. */
        preserveSelection?: boolean;
        searchContext?: { query?: string; resultCount?: number };
    }
    | {
        command: 'setBranches';
        local: string[];
        remote: string[];
        currentBranch?: string;
        /** Branches the user starred; empty when this root has none. */
        favorites?: string[];
        /** Branches HEAD recently moved through, newest first — git's own record. */
        recent?: string[];
    }
    | { command: 'setFavorites'; favorites: string[] }
    | { command: 'setStashes'; stashes: StashEntry[] }
    | { command: 'setStashDetail'; index: number; files: FileStat[]; error?: string }
    | { command: 'setWorktrees'; worktrees: WorktreeEntry[] }
    | {
        command: 'setRepoState';
        state: RepoUiState;
        files?: number;
        folder?: string;
        /**
         * Every repository of the workspace. Only more than one of these turns the
         * switcher on — a single-root workspace never sees the control.
         */
        repositories?: RepositoryOption[];
        /** Repository the panel is showing right now, out of `repositories`. */
        currentRepository?: string;
    }
    | { command: 'setCommits'; commits: GraphCommit[]; hasMore: boolean }
    | { command: 'appendCommits'; commits: GraphCommit[]; hasMore: boolean }
    | { command: 'prependCommits'; commits: GraphCommit[]; hasMoreAbove: boolean }
    | { command: 'loadMoreFailed' }
    | { command: 'loadMoreUpFailed' }
    | { command: 'setHeadHash'; headHash: string }
    | { command: 'setInProgress'; inProgress: OperationKind | null }
    | { command: 'setDivergence'; divergence: Record<string, DivergenceEntry> }
    | { command: 'setCurrentBranch'; branch: string }
    | {
        command: 'setDetail';
        commit: CommitDetail;
        files: FileStat[];
        /** Subset of `files` that still exists in the current working tree. */
        existingPaths: string[];
    }
    | {
        command: 'filePreviewResponse';
        /**
         * The selection the answer belongs to. The panel drops the reply unless
         * both still match: clicking through files fast must not paint an older
         * file's diff under the newest one.
         */
        hash?: string;
        /** Stash stack position, when the answer belongs to a stash's file list. */
        stash?: number;
        path: string;
        lines: DiffPreviewLine[];
        truncated: boolean;
        binary: boolean;
        /** No textual hunk at all — the file is unchanged in this commit or unmergeable. */
        empty: boolean;
        /** Already formatted for the user; only set when reading the diff failed. */
        error?: string;
    }
    | { command: 'setFileIconTheme'; pack?: FileIconPack }
    | {
        command: 'multiCommitsResponse';
        commits: CommitDetail[];
        files: FileStat[];
        /** Subset of the merged `files` that still exists in the working tree. */
        existingPaths?: string[];
    }
    | {
        command: 'revealCommit';
        hash: string;
        /** File to select in the changed-files list, e.g. the blamed file. */
        file?: string;
    }
    | { command: 'restoreViewState'; state: PersistedViewState }
    | { command: 'loading'; area: 'rows' | 'detail' | 'branches' | 'search' | 'multiCommits'; on: boolean }
    | { command: 'showDialog'; message: string; actions: string[]; type?: string }
    | { command: 'showSquashMessageDialog'; prompt: string; initialValue: string; placeholder: string }
    | {
        command: 'showPushDialog';
        branchName: string;
        commits: PushDialogCommit[];
        remoteExists: boolean;
        isFirstPush: boolean;
        /** Remote the push will target, so the dialog does not claim "origin" blindly. */
        remote: string;
        /** All configured remotes; more than one turns the dialog's picker on. */
        remotes: string[];
    }
    | { command: 'pushFilesResponse'; hash: string; files: Array<{ path: string; status: string }> }
    | {
        command: 'showFileHistory';
        filePath: string;
        history: Array<{ hash: string; shortHash: string; author: string; date: string; message: string }>;
    }
    | {
        command: 'showReflog';
        /** Which rev's reflog this is, shown as the dialog subtitle. */
        scope: string;
        entries: ReflogEntry[];
    }
    | {
        command: 'showCompareDialog';
        branchName: string;
        currentBranch: string;
        commits: PushDialogCommit[];
    }
    | { command: 'compareFilesResponse'; hash: string; files: Array<{ path: string; status: string }> }
    | { command: 'addBranchOptimistic'; branch: string; isCurrent: boolean }
    | { command: 'removeBranchOptimistic'; branch: string }
    | { command: 'renameBranchOptimistic'; oldName: string; newName: string }
    | { 
        command: 'showCherryPickResume'; 
        remainingHashes: string[]; 
        conflictHash: string; 
    };

/** Actions the webview can request via { command: 'action', action: ... }. */
export type WebviewAction =
    | 'continueOperation' | 'abortOperation'
    | 'checkout' | 'push' | 'pull' | 'fetch' | 'merge' | 'rebase' | 'update'
    | 'commit' | 'rename' | 'deleteBranch' | 'newBranchFrom' | 'compareBranch'
    | 'showDiff' | 'cherryPick' | 'reset' | 'dropCommit' | 'squashCommits' | 'interactiveRebase' | 'editMessage'
    | 'revert' | 'amend' | 'openRemoteCommit' | 'openRemoteBranch'
    | 'newTag' | 'deleteTag' | 'pushTag'
    | 'toggleFavorite'
    | 'stashSave' | 'stashApply' | 'stashPop' | 'stashDrop'
    | 'worktreeAdd' | 'worktreeOpen' | 'worktreeRemove'
    | 'reflog'
    | 'fileDiff' | 'fileJumpToSource' | 'fileCompareLocal' | 'fileCherryPick' | 'resumeCherryPick';

/** Messages sent from the webview to the extension host. */
export type WebviewToExtMessage =
    | { command: 'ready' }
    | { command: 'selectBranch'; branch: string }
    | { command: 'refresh' }
    | { command: 'refreshBranches' }
    | { command: 'initRepository' }
    | { command: 'recheckRepository' }
    | { command: 'selectRepository'; path: string }
    | { command: 'openScmView' }
    | { command: 'refreshFiles'; hash: string }
    | { command: 'showNotification'; message: string; type?: string }
    | { command: 'showStatusBarMessage'; message: string; timeout?: number }
    | { command: 'setFilters'; text?: string; author?: string; from?: string; to?: string; path?: string }
    | { command: 'loadMore' }
    | { command: 'loadMoreUp' }
    | { command: 'selectCommit'; hash: string; force?: boolean }
    | { command: 'selectCommits'; hashes: string[] }
    | { command: 'selectStash'; index: number }
    | {
        command: 'filePreview';
        /** Commit (or newest of the group) whose version of the file to show. */
        hash?: string;
        /** Every hash of a multi-select group; the host orders them by history. */
        hashes?: string[];
        /** Set instead of `hash` when the file rows belong to a stash. */
        stash?: number;
        path: string;
    }
    | {
        command: 'action';
        action: WebviewAction;
        branch?: string;
        hash?: string;
        hashes?: string[];
        path?: string;
        remainingHashes?: string[];
        /** Stash stack position (`stash@{n}`), for the stash tree section's actions. */
        stash?: number;
        /** Filesystem path of a worktree row, for worktree actions. */
        worktreePath?: string;
    }
    | { command: 'dialogAction'; action: string }
    | { command: 'squashMessageResponse'; message?: string }
    | { command: 'saveViewState'; state: PersistedViewState }
    | { command: 'pushDialogAction'; action: string; force?: boolean }
    | { command: 'pushDialogRemote'; remote: string }
    | { command: 'manageRemotes' }
    | { command: 'pushDialogFileDiff'; hash: string; path: string }
    | { command: 'getCommitFilesForPush'; hash: string }
    | { command: 'getPushAllFiles' }
    | { command: 'getCompareFiles'; hash: string }
    | { command: 'getCompareAllFiles' }
    | { command: 'compareFileDiff'; hash: string; path: string }
    | { command: 'compareDialogClosed' };
