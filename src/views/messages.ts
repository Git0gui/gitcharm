import { GraphCommit, CommitDetail, FileStat } from '../services/gitService';
import { FileIconPack } from '../services/fileIconTheme';

/**
 * Message protocol between the extension host and the graph webview.
 * Both sides must only send messages from these unions; the webview side
 * (media/webview.js) mirrors these shapes by convention — keep them in sync.
 */

export type OperationKind = 'rebase' | 'merge' | 'cherry-pick';

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
        headHash: string;
        inProgress?: OperationKind;
        searchContext?: { query?: string; resultCount?: number };
    }
    | { command: 'setBranches'; local: string[]; remote: string[]; currentBranch?: string }
    | { command: 'setRepoState'; state: RepoUiState; files?: number; folder?: string }
    | { command: 'setCommits'; commits: GraphCommit[]; hasMore: boolean }
    | { command: 'appendCommits'; commits: GraphCommit[]; hasMore: boolean }
    | { command: 'setHeadHash'; headHash: string }
    | { command: 'setInProgress'; inProgress: OperationKind | null }
    | { command: 'setDivergence'; divergence: Record<string, DivergenceEntry> }
    | { command: 'setCurrentBranch'; branch: string }
    | { command: 'setDetail'; commit: CommitDetail; files: FileStat[] }
    | { command: 'setFileIconTheme'; pack?: FileIconPack }
    | { command: 'multiCommitsResponse'; commits: CommitDetail[]; files: FileStat[] }
    | { command: 'revealCommit'; hash: string }
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
    }
    | { command: 'pushFilesResponse'; hash: string; files: Array<{ path: string; status: string }> }
    | {
        command: 'showFileHistory';
        filePath: string;
        history: Array<{ hash: string; shortHash: string; author: string; date: string; message: string }>;
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
    | 'fileDiff' | 'fileCompareLocal' | 'fileCherryPick' | 'resumeCherryPick';

/** Messages sent from the webview to the extension host. */
export type WebviewToExtMessage =
    | { command: 'ready' }
    | { command: 'selectBranch'; branch: string }
    | { command: 'refresh' }
    | { command: 'refreshBranches' }
    | { command: 'initRepository' }
    | { command: 'recheckRepository' }
    | { command: 'openScmView' }
    | { command: 'refreshFiles'; hash: string }
    | { command: 'showNotification'; message: string; type?: string }
    | { command: 'showStatusBarMessage'; message: string; timeout?: number }
    | { command: 'setFilters'; text?: string; author?: string; from?: string; to?: string }
    | { command: 'loadMore' }
    | { command: 'selectCommit'; hash: string; force?: boolean }
    | { command: 'selectCommits'; hashes: string[] }
    | {
        command: 'action';
        action: WebviewAction;
        branch?: string;
        hash?: string;
        hashes?: string[];
        path?: string;
        remainingHashes?: string[];
    }
    | { command: 'dialogAction'; action: string }
    | { command: 'squashMessageResponse'; message?: string }
    | { command: 'saveViewState'; state: PersistedViewState }
    | { command: 'pushDialogAction'; action: string; force?: boolean }
    | { command: 'pushDialogFileDiff'; hash: string; path: string }
    | { command: 'getCommitFilesForPush'; hash: string }
    | { command: 'getPushAllFiles' }
    | { command: 'getCompareFiles'; hash: string }
    | { command: 'getCompareAllFiles' }
    | { command: 'compareFileDiff'; hash: string; path: string }
    | { command: 'compareDialogClosed' };
