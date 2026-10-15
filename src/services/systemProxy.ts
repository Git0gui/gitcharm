import { execFile } from 'child_process';
import { parseWindowsProxySettings } from './gitUtils';
import { logger } from './logger';

const INTERNET_SETTINGS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/**
 * The proxy the operating system is configured with, or undefined when there is
 * none / it cannot be read. Called on the failure path only, after git's own
 * `http.proxy` turned out to be empty.
 *
 * Windows only, deliberately: an env-var proxy (`HTTPS_PROXY` and friends) is
 * something git already honours, so that case cannot produce "browser works, git
 * times out". The registry value is the one git is blind to.
 *
 * Never throws — this feeds a hint, and a hint that cannot be computed must not
 * replace the error the user actually needs.
 */
export function readWindowsSystemProxy(timeoutMs = 3000): Promise<string | undefined> {
    if (process.platform !== 'win32') {return Promise.resolve(undefined);}
    return new Promise((resolve) => {
        execFile(
            'reg.exe',
            ['query', INTERNET_SETTINGS_KEY],
            { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 },
            (error, stdout) => {
                if (error) {
                    logger.debug(`[GitCharm] system proxy lookup failed: ${error.message}`);
                    resolve(undefined);
                    return;
                }
                resolve(parseWindowsProxySettings(stdout));
            }
        );
    });
}
