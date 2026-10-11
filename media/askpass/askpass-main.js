// Entry point Git runs through media/askpass/git-askpass.sh. Plain node (no
// vscode): it hands the prompt to the extension host over a loopback, token
// guarded URL and prints the answer. Kept as JavaScript because git spawns it
// outside the extension host.
'use strict';

const http = require('http');

const addr = process.env.GITCHARM_ASKPASS_ADDR;
const prompt = process.argv[2] || '';

if (!addr) {
    process.stderr.write('GitCharm: askpass server address missing\n');
    process.exit(1);
}

let target;
try {
    target = new URL(addr);
} catch (e) {
    process.stderr.write('GitCharm: invalid askpass address\n');
    process.exit(1);
}

const body = JSON.stringify({ prompt });
const request = http.request({
    hostname: target.hostname,
    port: target.port,
    path: target.pathname,
    method: 'POST',
    headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
    }
}, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => {
        // 204: the user dismissed the input box, so git must give up.
        if (response.statusCode === 204) {
            process.exit(1);
        }
        try {
            const answer = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            process.stdout.write(String(answer.text === undefined ? '' : answer.text) + '\n');
        } catch (e) {
            process.stderr.write('GitCharm: unreadable askpass response\n');
            process.exit(1);
        }
    });
});

request.on('error', () => {
    process.stderr.write('GitCharm: cannot reach the extension host for credentials\n');
    process.exit(1);
});

request.end(body);
