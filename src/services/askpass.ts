import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { AddressInfo } from 'net';
import { logger } from './logger';
import { t } from '../i18n';

/** How long a credential prompt may sit unanswered before git is told to give up. */
const PROMPT_TIMEOUT_MS = 120_000;

/** Max accepted request body; a prompt is a short line, anything bigger is noise. */
const MAX_BODY_BYTES = 4096;

/**
 * Credential prompts for push/pull/fetch without the built-in git extension:
 * git runs `media/askpass/git-askpass.sh`, that script POSTs the prompt to this
 * loopback-only, token-guarded server, and the answer comes from a VS Code
 * input box. Without it `GIT_TERMINAL_PROMPT=0` makes HTTPS auth fail outright.
 */
export class GitAskpass implements vscode.Disposable {
    private _server: http.Server | undefined;
    private _listening: Promise<string> | undefined;
    private _url: string | undefined;
    private readonly _token = crypto.randomBytes(16).toString('hex');

    constructor(private readonly _extensionPath: string) {
        // Git needs the shebang script executable on POSIX shells.
        const script = this._scriptPath();
        try {
            if (fs.existsSync(script)) {fs.chmodSync(script, 0o755);}
        } catch (error) {
            logger.debug('[GitCharm] askpass chmod skipped:', error);
        }
    }

    /**
     * Environment for one network command. Every git invocation shares the
     * extension host's node binary, so `process.execPath` runs the JS entry
     * with ELECTRON_RUN_AS_NODE instead of opening a second VS Code window.
     */
    async prepare(): Promise<Record<string, string>> {
        const url = await this._ensureListening();
        return {
            GIT_ASKPASS: this._scriptPath(),
            GITCHARM_ASKPASS_ADDR: url,
            GITCHARM_ASKPASS_NODE: process.execPath,
            GITCHARM_ASKPASS_MAIN: path.join(this._extensionPath, 'media', 'askpass', 'askpass-main.js'),
            ELECTRON_RUN_AS_NODE: '1'
        };
    }

    private _scriptPath(): string {
        return path.join(this._extensionPath, 'media', 'askpass', 'git-askpass.sh');
    }

    private _ensureListening(): Promise<string> {
        if (this._url) {return Promise.resolve(this._url);}
        if (!this._listening) {
            this._listening = this._listen().catch(error => {
                this._listening = undefined;
                throw error;
            });
        }
        return this._listening;
    }

    private _listen(): Promise<string> {
        return new Promise((resolve, reject) => {
            const server = http.createServer((req, res) => void this._handle(req, res));
            server.once('error', reject);
            // Explicit loopback binding: never expose the prompt endpoint.
            server.listen(0, '127.0.0.1', () => {
                const port = (server.address() as AddressInfo).port;
                this._server = server;
                this._url = `http://127.0.0.1:${port}/${this._token}`;
                resolve(this._url);
            });
        });
    }

    private async _handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (req.method !== 'POST' || req.url !== `/${this._token}`) {
            res.writeHead(404);
            res.end();
            return;
        }

        let raw = '';
        req.setEncoding('utf8');
        for await (const chunk of req) {
            raw += chunk;
            if (raw.length > MAX_BODY_BYTES) {
                res.writeHead(413);
                res.end();
                return;
            }
        }

        let prompt = '';
        try {
            prompt = String(JSON.parse(raw || '{}').prompt ?? '');
        } catch {
            res.writeHead(400);
            res.end();
            return;
        }

        // git words its requests ("Password for 'https://…'", "Enter passphrase
        // for key '…'"); anything secret-shaped must not echo in the box.
        const secret = /password|passphrase|token|pin\b/i.test(prompt);
        const answer = await this._prompt(prompt, secret);

        if (answer === undefined) {
            res.writeHead(204);
            res.end();
            return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text: answer }));
    }

    /** undefined means cancelled or timed out, which git must treat as failure. */
    private async _prompt(prompt: string, secret: boolean): Promise<string | undefined> {
        const box = vscode.window.showInputBox({
            prompt: prompt || t('auth.placeholder'),
            password: secret,
            ignoreFocusOut: true,
            placeHolder: secret ? t('auth.secretPlaceholder') : t('auth.valuePlaceholder')
        });
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<undefined>(resolve => {
            timer = setTimeout(() => resolve(undefined), PROMPT_TIMEOUT_MS);
        });
        try {
            return await Promise.race([box, timeout]);
        } finally {
            if (timer) {clearTimeout(timer);}
        }
    }

    dispose(): void {
        this._server?.close();
        this._server = undefined;
        this._url = undefined;
    }
}
