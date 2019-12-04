// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import * as Cors from '@koa/cors';
import * as fs from 'fs-extra';
import * as Koa from 'koa';
import * as compress from 'koa-compress';
import * as logger from 'koa-logger';
import * as path from 'path';
import * as Stream from 'stream';

import { EXTENSION_ROOT_DIR } from '../../../constants';
import { Identifiers } from '../../../datascience/constants';
import { SharedMessages } from '../../../datascience/messages';
import { noop } from '../../utils/misc';

interface INotebookState {
    cwd: string;
    outDir: string;
    bundle: string;
}

const notebookState = new Map<string, INotebookState>();
const expectedToken: string = process.argv[5];

// Create a new Koa App to host our web server
const app = new Koa();
app.use(Cors());
app.use(compress());
app.use(logger());
app.use(async ctx => {
    try {
        // Either token is passed or cookie exists, otherwise insecure connection
        if (ctx.query.token) {
            if (ctx.query.token === expectedToken) {
                if (ctx.query.scripts) {
                    await generateNotebookResponse(ctx);
                } else {
                    await generateFileResponse(ctx);
                }
            }
        } else {
            const id = ctx.cookies.get('id');
            const state = id ? notebookState.get(id) : undefined;
            if (state) {
                if (ctx.query.scripts) {
                    await generateNotebookResponse(ctx);
                } else {
                    await generateFileResponse(ctx);
                }
            }
        }
    } catch (e) {
        ctx.body = `<div>${e}</div>`;
    }
});

// Port should be passed in
// args should be of form 'node', 'path to this file', '--port', 'port number'
app.listen(parseInt(process.argv[3], 10), 'localhost');

async function generateNotebookResponse(ctx: Koa.ParameterizedContext) {
    const readable = new Stream.Readable();
    readable._read = noop;
    const id = ctx.path.substr(1);
    let state = notebookState.get(id);
    if (!state) {
        state = {
            cwd: ctx.query.cwd,
            outDir: ctx.query.rootPath,
            bundle: generateReactHtml(ctx.query)
        };
        notebookState.set(id, state);
    }
    readable.push(state.bundle);
    readable.push(null);
    ctx.body = readable;
    ctx.cookies.set('id', id);
    ctx.type = 'html';
}

async function generateFileResponse(ctx: Koa.ParameterizedContext) {
    const id = ctx.cookies.get('id');
    const state = id ? notebookState.get(id) : undefined;
    const cwd = state ? state.cwd : process.cwd();
    const root = state ? state.outDir : cwd;
    let filePath = path.join(cwd, ctx.url);

    switch (ctx.url) {
        case '/editor.worker.js':
            // This is actually in the root out folder
            filePath = path.join(EXTENSION_ROOT_DIR, 'out', ctx.url);
            break;

        case '/index_bundle.js':
            // This is in the root folder
            filePath = path.join(root, ctx.url);
            break;

        // Here is where we'd likely support loading split bundles.
        default:
            break;

    }
    ctx.body = fs.createReadStream(filePath);
}

// Debugging tips:
// As the developer tools no longer work when using an http source for an iframe, it can be difficult to debug the code below.
// Here's some tips:
// 1) If you get no output, try entering the URL of the server into Chrome on the same machine as the extension.
//    You can then debug this code outside of a frame, but only the raw startup of the frame.
//    Note, the URL is usually http://localhost:9000?queryparams, not http://localhost:9890 as this is the remapped URL
// 2) If you get the wrong output, and you think the error is in the react code, set the 'python.dataScience.skipWebViewServer' to true in your settings.json.
//    This will switch the code to use the old way to render.
// 3) If you suspect some of the code below but you do get output on startup, copy some of the code into a codepen and debug it there.

// tslint:disable: no-any
function generateReactHtml(query: any) {
    const uriBase = ''; //webView.asWebviewUri(Uri.file(this.rootPath));
    const scripts = query.scripts ? Array.isArray(query.scripts) ? query.Scripts : [query.scripts] : [''];

    return `<!doctype html>
    <html lang="en">
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
            <meta http-equiv="Content-Security-Policy" content="img-src 'self' data: https: http: blob:; default-src 'unsafe-inline' 'unsafe-eval' vscode-resource: data: https: http:;">
            <meta name="theme-color" content="#000000">
            <meta name="theme" content="${Identifiers.GeneratedThemeName}"/>
            <title>React App</title>
        </head>
        <body class='${query.baseTheme}'>
            <noscript>You need to enable JavaScript to run this app.</noscript>
            <div id="root"></div>
            <script type="text/javascript">
            ${getVsCodeApiScript({})}
            </script>
            <script type="text/javascript">
                function resolvePath(relativePath) {
                    if (relativePath && relativePath[0] == '.' && relativePath[1] != '.') {
                        return "${uriBase}" + relativePath.substring(1);
                    }

                    return "${uriBase}" + relativePath;
                }
            </script>
            <script type="text/javascript">
            ${getStyleUpdateScript()}
            </script>
            ${scripts.map((script: string) => `<script type="text/javascript" src="${script}"></script>`).join('\n')}
        </body>
    </html>`;
}

function getVsCodeApiScript(state: any) {
    return `
        const acquireVsCodeApi = (function() {
            const originalPostMessage = window.parent.postMessage.bind(window.parent);
            const targetOrigin = '*';
            let acquired = false;

            let state = ${state ? `JSON.parse("${JSON.stringify(state)}")` : undefined};
            window.console.log('acquired vscode api');

            return () => {
                if (acquired) {
                    throw new Error('An instance of the VS Code API has already been acquired');
                }
                acquired = true;
                return Object.freeze({
                    postMessage: function(msg) {
                        return originalPostMessage({ command: 'onmessage', data: msg }, targetOrigin);
                    },
                    setState: function(newState) {
                        state = newState;
                        originalPostMessage({ command: 'do-update-state', data: JSON.stringify(newState) }, targetOrigin);
                        return newState;
                    },
                    getState: function() {
                        return state;
                    }
                });
            };
        })();
        delete window.parent;
        delete window.top;
        delete window.frameElement;
    `;
}

function getStyleUpdateScript() {
    return `
        window.addEventListener('message', (ev) => {
            // Do all of this here instead of in the react code so that whether or not we're using a server is
            // transparent to the react code. It just assumes the root is correct.
            if (ev.data && ev.data.type && ev.data.type === '${SharedMessages.StyleUpdate}') {
                window.console.log('WebServer Frame: Received style update');
                try {
                    document.documentElement.setAttribute('style', ev.data.payload.styleText);
                    document.body.classList.remove('vscode-light', 'vscode-dark', 'vscode-high-contrast');
                    document.body.classList.add(ev.data.payload.bodyClass);
                    let defaultStylesNode = document.getElementById('_defaultStyles');
                    if (defaultStylesNode) {
                        defaultStylesNode.remove();
                    }
                    defaultStylesNode = document.createElement('style');
                    defaultStylesNode.appendChild(document.createTextNode(ev.data.payload.defaultStyles));
                    document.head.appendChild(defaultStylesNode);

                    // The body padding is off because of the assumptions made about frames being inside of each other
                    // Remove the padding on the body style
                    const rules = [...defaultStylesNode.sheet.cssRules];
                    const index = rules.findIndex(r => r.selectorText === 'body');
                    if (index >= 0) {
                        rules[index].style.padding = '';
                    }

                } catch (e) {
                    window.console.log('WebServer Frame: error ' + e.toString());
                }
            } else if (ev.data && ev.data.type) {
                window.console.log('WebServer Frame: Received message ' + ev.data.type);
            }
        });
    `;
}
