// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import '../../common/extensions';

import { inject, injectable, named } from 'inversify';
import * as path from 'path';
import {
    CancellationToken,
    CodeLens,
    CompletionContext,
    CompletionItem,
    CompletionList,
    DocumentSymbol,
    Hover,
    Location,
    LocationLink,
    Position,
    ProviderResult,
    ReferenceContext,
    SignatureHelp,
    SignatureHelpContext,
    SymbolInformation,
    TextDocument,
    WorkspaceEdit
} from 'vscode';
import * as vscodeLanguageClient from 'vscode-languageclient';

import { ICommandManager } from '../../common/application/types';
import { traceDecorators, traceError } from '../../common/logger';
import { IFileSystem } from '../../common/platform/types';
import { IConfigurationService, Resource } from '../../common/types';
import { sleep } from '../../common/utils/async';
import { debounceSync, swallowExceptions } from '../../common/utils/decorators';
import { noop } from '../../common/utils/misc';
import { EXTENSION_ROOT_DIR } from '../../constants';
import { PythonInterpreter } from '../../interpreter/contracts';
import { LanguageServerSymbolProvider } from '../../providers/symbolProvider';
import { captureTelemetry, sendTelemetryEvent } from '../../telemetry';
import { EventName } from '../../telemetry/constants';
import { ITestManagementService } from '../../testing/types';
import {
    ILanguageClientFactory,
    ILanguageServerAnalysisOptions,
    ILanguageServerDownloader,
    ILanguageServerExtension,
    ILanguageServerFolderService,
    IStartableLanguageServer,
    LanguageClientFactory
} from '../types';
import { Commands } from './constants';
import { ProgressReporting } from './progress';

@injectable()
export class DotNetServer implements IStartableLanguageServer {
    public languageClient: vscodeLanguageClient.LanguageClient | undefined;
    private readonly disposables: vscodeLanguageClient.Disposable[] = [];
    private disposed: boolean = false;
    private extensionLoadedArgs = new Set<{}>();
    private resource: Resource | undefined;
    private interpreter: PythonInterpreter | undefined;

    constructor(
        @inject(ILanguageClientFactory)
        @named(LanguageClientFactory.base)
        private readonly factory: ILanguageClientFactory,
        @inject(ITestManagementService) private readonly testManager: ITestManagementService,
        @inject(IConfigurationService) private readonly configurationService: IConfigurationService,
        @inject(ICommandManager) private readonly commandManager: ICommandManager,
        @inject(ILanguageServerAnalysisOptions) private readonly analysisOptions: ILanguageServerAnalysisOptions,
        @inject(ILanguageServerExtension) private readonly lsExtension: ILanguageServerExtension,
        @inject(IFileSystem) private readonly fs: IFileSystem,
        @inject(ILanguageServerDownloader) private readonly lsDownloader: ILanguageServerDownloader,
        @inject(ILanguageServerFolderService) private readonly languageServerFolderService: ILanguageServerFolderService
    ) {
        this.analysisOptions.onDidChange(this.restartDebounced, this, this.disposables);
        this.lsExtension.invoked(this.handleIntellicodeCommands.bind(this));
    }
    @traceDecorators.verbose('Stopping Language Server')
    public dispose() {
        if (this.languageClient) {
            // Do not await on this.
            this.languageClient.stop().then(noop, ex => traceError('Stopping language client failed', ex));
            this.languageClient = undefined;
        }
        while (this.disposables.length > 0) {
            const d = this.disposables.shift()!;
            d.dispose();
        }
        this.disposed = true;
    }

    public async startup(resource: Resource, interpreter?: PythonInterpreter): Promise<void> {
        // Save resource and interpreter in case our analysis options change.
        this.resource = resource;
        this.interpreter = interpreter;

        // Make sure we have a language server in the first place.
        await this.ensureLanguageServerIsAvailable(resource);

        // Initialize our analysis options
        await this.analysisOptions.initialize(resource, interpreter);

        // Start our language client (its the go between this object and the ILanguageServer implementation)
        return this.startLanguageClient(resource, interpreter, await this.analysisOptions.getAnalysisOptions());
    }

    public provideRenameEdits(document: TextDocument, position: Position, newName: string, token: CancellationToken): ProviderResult<WorkspaceEdit> {
        return this.handleProvideRenameEdits(document, position, newName, token);
    }

    public provideDefinition(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<Location | Location[] | LocationLink[]> {
        return this.handleProvideDefinition(document, position, token);
    }

    public provideHover(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<Hover> {
        return this.handleProvideHover(document, position, token);
    }

    public provideReferences(document: TextDocument, position: Position, context: ReferenceContext, token: CancellationToken): ProviderResult<Location[]> {
        return this.handleProvideReferences(document, position, context, token);
    }

    public provideCompletionItems(document: TextDocument, position: Position, token: CancellationToken, context: CompletionContext): ProviderResult<CompletionItem[] | CompletionList> {
        return this.handleProvideCompletionItems(document, position, token, context);
    }

    public provideCodeLenses(document: TextDocument, token: CancellationToken): ProviderResult<CodeLens[]> {
        return this.handleProvideCodeLenses(document, token);
    }

    public provideDocumentSymbols(document: TextDocument, token: CancellationToken): ProviderResult<SymbolInformation[] | DocumentSymbol[]> {
        return this.handleProvideDocumentSymbols(document, token);
    }

    public provideSignatureHelp(document: TextDocument, position: Position, token: CancellationToken, context: SignatureHelpContext): ProviderResult<SignatureHelp> {
        return this.handleProvideSignatureHelp(document, position, token, context);
    }

    private async handleProvideRenameEdits(document: TextDocument, position: Position, newName: string, token: CancellationToken): Promise<WorkspaceEdit | undefined> {
        if (this.languageClient) {
            const args: vscodeLanguageClient.RenameParams = {
                textDocument: this.languageClient.code2ProtocolConverter.asTextDocumentIdentifier(document),
                position: this.languageClient.code2ProtocolConverter.asPosition(position),
                newName
            };
            const result = await this.languageClient.sendRequest(
                vscodeLanguageClient.RenameRequest.type,
                args,
                token
            );
            if (result) {
                return this.languageClient.protocol2CodeConverter.asWorkspaceEdit(result);
            }
        }
    }

    private async handleProvideDefinition(document: TextDocument, position: Position, token: CancellationToken): Promise<Location | Location[] | LocationLink[] | undefined> {
        if (this.languageClient) {
            const args: vscodeLanguageClient.TextDocumentPositionParams = {
                textDocument: this.languageClient.code2ProtocolConverter.asTextDocumentIdentifier(document),
                position: this.languageClient.code2ProtocolConverter.asPosition(position)
            };
            const result = await this.languageClient.sendRequest(
                vscodeLanguageClient.DefinitionRequest.type,
                args,
                token
            );
            if (result) {
                return this.languageClient.protocol2CodeConverter.asDefinitionResult(result);
            }
        }
    }

    private async handleProvideHover(document: TextDocument, position: Position, token: CancellationToken): Promise<Hover | undefined> {
        if (this.languageClient) {
            const args: vscodeLanguageClient.TextDocumentPositionParams = {
                textDocument: this.languageClient.code2ProtocolConverter.asTextDocumentIdentifier(document),
                position: this.languageClient.code2ProtocolConverter.asPosition(position)
            };
            const result = await this.languageClient.sendRequest(
                vscodeLanguageClient.HoverRequest.type,
                args,
                token
            );
            if (result) {
                return this.languageClient.protocol2CodeConverter.asHover(result);
            }
        }
    }

    private async handleProvideReferences(document: TextDocument, position: Position, context: ReferenceContext, token: CancellationToken): Promise<Location[] | undefined> {
        if (this.languageClient) {
            const args: vscodeLanguageClient.ReferenceParams = {
                textDocument: this.languageClient.code2ProtocolConverter.asTextDocumentIdentifier(document),
                position: this.languageClient.code2ProtocolConverter.asPosition(position),
                context
            };
            const result = await this.languageClient.sendRequest(
                vscodeLanguageClient.ReferencesRequest.type,
                args,
                token
            );
            if (result) {
                // Remove undefined part.
                return result.map(l => {
                    const r = this.languageClient!.protocol2CodeConverter.asLocation(l);
                    return r!;
                });
            }
        }
    }

    private async handleProvideCodeLenses(document: TextDocument, token: CancellationToken): Promise<CodeLens[] | undefined> {
        if (this.languageClient) {
            const args: vscodeLanguageClient.CodeLensParams = {
                textDocument: this.languageClient.code2ProtocolConverter.asTextDocumentIdentifier(document)
            };
            const result = await this.languageClient.sendRequest(
                vscodeLanguageClient.CodeLensRequest.type,
                args,
                token
            );
            if (result) {
                return this.languageClient.protocol2CodeConverter.asCodeLenses(result);
            }
        }
    }

    private async handleProvideCompletionItems(document: TextDocument, position: Position, token: CancellationToken, context: CompletionContext): Promise<CompletionItem[] | CompletionList | undefined> {
        if (this.languageClient) {
            const args = this.languageClient.code2ProtocolConverter.asCompletionParams(document, position, context);
            const result = await this.languageClient.sendRequest(
                vscodeLanguageClient.CompletionRequest.type,
                args,
                token
            );
            if (result) {
                return this.languageClient.protocol2CodeConverter.asCompletionResult(result);
            }
        }
    }

    private async handleProvideDocumentSymbols(document: TextDocument, token: CancellationToken): Promise<SymbolInformation[] | DocumentSymbol[] | undefined> {
        if (this.languageClient) {
            const args: vscodeLanguageClient.DocumentSymbolParams = {
                textDocument: this.languageClient.code2ProtocolConverter.asTextDocumentIdentifier(document)
            };
            const result = await this.languageClient.sendRequest(
                vscodeLanguageClient.DocumentSymbolRequest.type,
                args,
                token
            );
            if (result && result.length) {
                // tslint:disable-next-line: no-any
                if ((result[0] as any).range) {
                    // Document symbols
                    const docSymbols = result as vscodeLanguageClient.DocumentSymbol[];
                    return this.languageClient.protocol2CodeConverter.asDocumentSymbols(docSymbols);
                } else {
                    // Document symbols
                    const symbols = result as vscodeLanguageClient.SymbolInformation[];
                    return this.languageClient.protocol2CodeConverter.asSymbolInformations(symbols);
                }
            }
        }
    }

    private async handleProvideSignatureHelp(document: TextDocument, position: Position, token: CancellationToken, _context: SignatureHelpContext): Promise<SignatureHelp | undefined> {
        if (this.languageClient) {
            const args: vscodeLanguageClient.TextDocumentPositionParams = {
                textDocument: this.languageClient.code2ProtocolConverter.asTextDocumentIdentifier(document),
                position: this.languageClient.code2ProtocolConverter.asPosition(position)
            };
            const result = await this.languageClient.sendRequest(
                vscodeLanguageClient.SignatureHelpRequest.type,
                args,
                token
            );
            if (result) {
                return this.languageClient.protocol2CodeConverter.asSignatureHelp(result);
            }
        }
    }

    @debounceSync(1000)
    private restartDebounced(): void {
        this.restart().ignoreErrors();
    }

    private restart(): Promise<void> {
        this.dispose();
        return this.startup(this.resource, this.interpreter);
    }

    @traceDecorators.error('Failed to load Language Server extension')
    private handleIntellicodeCommands() {
        const args = this.lsExtension.loadExtensionArgs;
        if (this.extensionLoadedArgs.has(args || '')) {
            return;
        }
        this.extensionLoadedArgs.add(args || '');
        if (this.languageClient) {
            this.languageClient.sendRequest('python/loadExtension', args).then(noop, ex =>
                traceError('Request python/loadExtension failed', ex)
            );
        }
    }

    @captureTelemetry(EventName.PYTHON_LANGUAGE_SERVER_READY, undefined, true)
    private async serverReady(): Promise<void> {
        while (this.languageClient && !this.languageClient!.initializeResult) {
            await sleep(100);
        }
    }

    @swallowExceptions('Activating Unit Tests Manager for Language Server')
    private async registerTestServices() {
        if (!this.languageClient) {
            throw new Error('languageClient not initialized');
        }
        await this.testManager.activate(new LanguageServerSymbolProvider(this.languageClient!));
    }

    @traceDecorators.error('Failed to start language server')
    @captureTelemetry(EventName.PYTHON_LANGUAGE_SERVER_ENABLED, undefined, true)
    private async startLanguageClient(resource: Resource, interpreter: PythonInterpreter | undefined, options: vscodeLanguageClient.LanguageClientOptions): Promise<void> {
        if (!this.languageClient) {
            this.languageClient = await this.factory.createLanguageClient(resource, interpreter, options);
            this.disposables.push(this.languageClient.start());
            await this.serverReady();
            if (this.disposed) {
                // Check if it got disposed in the interim.
                return;
            }
            const progressReporting = new ProgressReporting(this.languageClient);
            this.disposables.push(progressReporting);

            const settings = this.configurationService.getSettings(resource);
            if (settings.downloadLanguageServer) {
                this.languageClient!.onTelemetry(telemetryEvent => {
                    const eventName = telemetryEvent.EventName || EventName.PYTHON_LANGUAGE_SERVER_TELEMETRY;
                    sendTelemetryEvent(eventName, telemetryEvent.Measurements, telemetryEvent.Properties);
                });
            }

            this.registerCommands();
            await this.registerTestServices();
        }
    }
    private registerCommands() {
        const disposable = this.commandManager.registerCommand(Commands.ClearAnalyisCache, this.onClearAnalysisCache, this);
        this.disposables.push(disposable);
    }
    private async onClearAnalysisCache() {
        if (this.languageClient) {
            this.languageClient.sendRequest('python/clearAnalysisCache').then(noop, ex =>
                traceError('Request python/clearAnalysisCache failed', ex)
            );
        }
    }
    @traceDecorators.error('Failed to ensure language server is available')
    private async ensureLanguageServerIsAvailable(resource: Resource) {
        const settings = this.configurationService.getSettings(resource);
        if (!settings.downloadLanguageServer) {
            return;
        }
        const languageServerFolder = await this.languageServerFolderService.getLanguageServerFolderName(resource);
        const languageServerFolderPath = path.join(EXTENSION_ROOT_DIR, languageServerFolder);
        const mscorlib = path.join(languageServerFolderPath, 'mscorlib.dll');
        if (!(await this.fs.fileExists(mscorlib))) {
            await this.lsDownloader.downloadLanguageServer(languageServerFolderPath, this.resource);
            await this.prepareLanguageServerForNoICU(languageServerFolderPath);
        }
    }
    private async prepareLanguageServerForNoICU(languageServerFolderPath: string): Promise<void> {
        const targetJsonFile = path.join(languageServerFolderPath, 'Microsoft.Python.LanguageServer.runtimeconfig.json');
        // tslint:disable-next-line:no-any
        let content: any = {};
        if (await this.fs.fileExists(targetJsonFile)) {
            try {
                content = JSON.parse(await this.fs.readFile(targetJsonFile));
                if (content.runtimeOptions && content.runtimeOptions.configProperties &&
                    content.runtimeOptions.configProperties['System.Globalization.Invariant'] === true) {
                    return;
                }
            } catch {
                // Do nothing.
            }
        }
        content.runtimeOptions = content.runtimeOptions || {};
        content.runtimeOptions.configProperties = content.runtimeOptions.configProperties || {};
        content.runtimeOptions.configProperties['System.Globalization.Invariant'] = true;
        await this.fs.writeFile(targetJsonFile, JSON.stringify(content));
    }

}
