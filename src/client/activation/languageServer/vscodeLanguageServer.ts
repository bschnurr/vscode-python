// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import { inject, injectable } from 'inversify';
import {
    CancellationToken,
    CodeLens,
    CompletionContext,
    CompletionItem,
    CompletionList,
    DocumentFilter,
    DocumentSymbol,
    Event,
    EventEmitter,
    Hover,
    languages,
    Location,
    LocationLink,
    Position,
    ProviderResult,
    ReferenceContext,
    SignatureHelp,
    SignatureHelpContext,
    SymbolInformation,
    TextDocument,
    TextEditor,
    WorkspaceEdit
} from 'vscode';

import { IDocumentManager } from '../../common/application/types';
import { PYTHON } from '../../common/constants';
import { IConfigurationService, IDisposable, IExtensionContext } from '../../common/types';
import { noop } from '../../common/utils/misc';
import { BlockFormatProviders } from '../../typeFormatters/blockFormatProvider';
import { OnTypeFormattingDispatcher } from '../../typeFormatters/dispatcher';
import { OnEnterFormatter } from '../../typeFormatters/onEnterFormatter';
import { IExtensionSingleActivationService, ILanguageServer, ILanguageServerCache } from '../types';

@injectable()
export class VsCodeLanguageServer implements IExtensionSingleActivationService, ILanguageServer {
    private readonly documentSelector: DocumentFilter[];
    private activeServer: ILanguageServer | undefined;
    private activeClientDisposable: IDisposable | undefined;
    private didChangeCodeLensesEmitter: EventEmitter<void> = new EventEmitter<void>();

    constructor(
        @inject(IExtensionContext) private context: IExtensionContext,
        @inject(ILanguageServerCache) private cache: ILanguageServerCache,
        @inject(IDocumentManager) private docManager: IDocumentManager,
        @inject(IConfigurationService) private configService: IConfigurationService
    ) {
        this.documentSelector = PYTHON;
        this.docManager.onDidChangeActiveTextEditor(this.changedTextEditor.bind(this));
    }

    public provideRenameEdits(document: TextDocument, position: Position, newName: string, token: CancellationToken): ProviderResult<WorkspaceEdit> {
        if (this.activeServer) {
            return this.activeServer.provideRenameEdits(document, position, newName, token);
        }
    }
    public provideDefinition(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<Location | Location[] | LocationLink[]> {
        if (this.activeServer) {
            return this.activeServer.provideDefinition(document, position, token);
        }
    }
    public provideHover(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<Hover> {
        if (this.activeServer) {
            return this.activeServer.provideHover(document, position, token);
        }
    }
    public provideReferences(document: TextDocument, position: Position, context: ReferenceContext, token: CancellationToken): ProviderResult<Location[]> {
        if (this.activeServer) {
            return this.activeServer.provideReferences(document, position, context, token);
        }
    }
    public provideCompletionItems(document: TextDocument, position: Position, token: CancellationToken, context: CompletionContext): ProviderResult<CompletionItem[] | CompletionList> {
        if (this.activeServer) {
            return this.activeServer.provideCompletionItems(document, position, token, context);
        }
    }
    public get onDidChangeCodeLenses(): Event<void> | undefined {
        return this.didChangeCodeLensesEmitter.event;
    }
    public provideCodeLenses(document: TextDocument, token: CancellationToken): ProviderResult<CodeLens[]> {
        if (this.activeServer) {
            return this.activeServer.provideCodeLenses(document, token);
        }
    }
    public provideDocumentSymbols(document: TextDocument, token: CancellationToken): ProviderResult<SymbolInformation[] | DocumentSymbol[]> {
        if (this.activeServer) {
            return this.activeServer.provideDocumentSymbols(document, token);
        }
    }
    public provideSignatureHelp(document: TextDocument, position: Position, token: CancellationToken, context: SignatureHelpContext): ProviderResult<SignatureHelp> {
        if (this.activeServer) {
            return this.activeServer.provideSignatureHelp(document, position, token, context);
        }
    }

    public dispose(): void {
        noop();
    }

    public async activate(): Promise<void> {
        const context = this.context;

        context.subscriptions.push(
            languages.registerRenameProvider(this.documentSelector, this)
        );
        context.subscriptions.push(languages.registerDefinitionProvider(this.documentSelector, this));
        context.subscriptions.push(
            languages.registerHoverProvider(this.documentSelector, this)
        );
        context.subscriptions.push(
            languages.registerReferenceProvider(this.documentSelector, this)
        );
        context.subscriptions.push(
            languages.registerCompletionItemProvider(
                this.documentSelector,
                this,
                '.'
            )
        );
        context.subscriptions.push(
            languages.registerCodeLensProvider(
                this.documentSelector,
                this
            )
        );

        const onTypeDispatcher = new OnTypeFormattingDispatcher({
            '\n': new OnEnterFormatter(),
            ':': new BlockFormatProviders()
        });
        const onTypeTriggers = onTypeDispatcher.getTriggerCharacters();
        if (onTypeTriggers) {
            context.subscriptions.push(
                languages.registerOnTypeFormattingEditProvider(
                    PYTHON,
                    onTypeDispatcher,
                    onTypeTriggers.first,
                    ...onTypeTriggers.more
                )
            );
        }

        context.subscriptions.push(languages.registerDocumentSymbolProvider(this.documentSelector, this));

        const pythonSettings = this.configService.getSettings();
        if (pythonSettings.devOptions.indexOf('DISABLE_SIGNATURE') === -1) {
            context.subscriptions.push(
                languages.registerSignatureHelpProvider(
                    this.documentSelector,
                    this,
                    '(',
                    ','
                )
            );
        }
    }

    private changedTextEditor(e: TextEditor | undefined) {
        if (e && e.document) {
            this.cache.get(e.document.uri).then(this.changedActiveClient.bind(this)).ignoreErrors();
        }
    }

    private changedActiveClient(newClient: ILanguageServer) {
        if (newClient !== this.activeServer) {
            if (this.activeClientDisposable) {
                this.activeClientDisposable.dispose();
            }
            if (newClient.onDidChangeCodeLenses) {
                this.activeClientDisposable = newClient.onDidChangeCodeLenses(this.fireChangeCodeLenses.bind(this));
            }
            this.activeServer = newClient;
        }
    }

    private fireChangeCodeLenses() {
        this.didChangeCodeLensesEmitter.fire();
    }
}
