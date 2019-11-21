// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import { inject, injectable, named } from 'inversify';
import { Disposable, LanguageClient, LanguageClientOptions } from 'vscode-languageclient';
import { ICommandManager } from '../../common/application/types';
import '../../common/extensions';
import { traceDecorators, traceError } from '../../common/logger';
import { IConfigurationService, Resource } from '../../common/types';
import { createDeferred, Deferred, sleep } from '../../common/utils/async';
import { swallowExceptions } from '../../common/utils/decorators';
import { noop } from '../../common/utils/misc';
import { LanguageServerSymbolProvider } from '../../providers/symbolProvider';
import { captureTelemetry, sendTelemetryEvent } from '../../telemetry';
import { EventName } from '../../telemetry/constants';
import { ITestManagementService } from '../../testing/types';
import { ILanguageClientFactory, ILanguageServer, LanguageClientFactory, IStartableLanguageServer, ILanguageServerAnalysisOptions } from '../types';
import { Commands } from './constants';
import { ProgressReporting } from './progress';
import { PythonInterpreter } from '../../interpreter/contracts';

@injectable()
export class DotNetServer implements IStartableLanguageServer {
    public languageClient: LanguageClient | undefined;
    private readonly disposables: Disposable[] = [];
    private disposed: boolean = false;

    constructor(
        @inject(ILanguageClientFactory)
        @named(LanguageClientFactory.base)
        private readonly factory: ILanguageClientFactory,
        @inject(ITestManagementService) private readonly testManager: ITestManagementService,
        @inject(IConfigurationService) private readonly configurationService: IConfigurationService,
        @inject(ICommandManager) private readonly commandManager: ICommandManager,
        @inject(ILanguageServerAnalysisOptions) private readonly analysisOptions: ILanguageServerAnalysisOptions
    ) {
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
        // Initialize our analysis options
        await this.analysisOptions.initialize(resource, interpreter);
        // Start our language client (its the go between this object and the ILanguageServer implementation)
        return this.startLanguageClient(resource, interpreter, await this.analysisOptions.getAnalysisOptions());
    }

    @captureTelemetry(EventName.PYTHON_LANGUAGE_SERVER_READY, undefined, true)
    protected async serverReady(): Promise<void> {
        while (this.languageClient && !this.languageClient!.initializeResult) {
            await sleep(100);
        }
    }
    @swallowExceptions('Activating Unit Tests Manager for Language Server')
    protected async registerTestServices() {
        if (!this.languageClient) {
            throw new Error('languageClient not initialized');
        }
        await this.testManager.activate(new LanguageServerSymbolProvider(this.languageClient!));
    }

    @traceDecorators.error('Failed to start language server')
    @captureTelemetry(EventName.PYTHON_LANGUAGE_SERVER_ENABLED, undefined, true)
    private async startLanguageClient(resource: Resource, interpreter: PythonInterpreter | undefined, options: LanguageClientOptions): Promise<void> {
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
}
