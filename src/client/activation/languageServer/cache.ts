// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import '../../common/extensions';

import { inject, injectable } from 'inversify';
import { ConfigurationChangeEvent, Disposable, Uri } from 'vscode';

import { IDiagnosticsService } from '../../application/diagnostics/types';
import { IApplicationShell, ICommandManager, IWorkspaceService } from '../../common/application/types';
import { LSControl, LSEnabled } from '../../common/experimentGroups';
import { traceError } from '../../common/logger';
import {
    IConfigurationService,
    IDisposableRegistry,
    IExperimentsManager,
    IOutputChannel,
    IPersistentStateFactory,
    IPythonSettings,
    Resource
} from '../../common/types';
import { swallowExceptions } from '../../common/utils/decorators';
import * as localize from '../../common/utils/localize';
import { PythonInterpreter } from '../../interpreter/contracts';
import { sendTelemetryEvent } from '../../telemetry';
import { EventName } from '../../telemetry/constants';
import {
    IExtensionActivationService,
    ILanguageServer,
    ILanguageServerCache,
    IStartableLanguageServer,
    LanguageServerType
} from '../types';
import { IServiceContainer } from '../../ioc/types';

const jediEnabledSetting: keyof IPythonSettings = 'jediEnabled';
const workspacePathNameForGlobalWorkspaces = '';
type ServerInfo = { jedi: boolean; server: IStartableLanguageServer };

@injectable()
export class LanguageServerCache implements IExtensionActivationService, ILanguageServerCache, Disposable {
    private cache = new Map<string, Promise<IStartableLanguageServer>>();
    private jediServer: IStartableLanguageServer | undefined;
    private currentServer?: ServerInfo;
    private resource!: Resource;

    constructor(@inject(IWorkspaceService) private workspaceService: IWorkspaceService,
        @inject(IPersistentStateFactory) private stateFactory: IPersistentStateFactory,
        @inject(IExperimentsManager) private readonly abExperiments: IExperimentsManager,

        @inject(IOutputChannel) private output: IOutputChannel,
        @inject(IApplicationShell) private appShell: IApplicationShell,
        @inject(IDiagnosticsService) private lsNotSupportedDiagnosticService: IDiagnosticsService,
        @inject(IDisposableRegistry) disposables: IDisposableRegistry,
        @inject(IConfigurationService) private configService: IConfigurationService,
        @inject(IServiceContainer) private serviceContainer: IServiceContainer

    ) {
        disposables.push(this);
        disposables.push(this.workspaceService.onDidChangeConfiguration(this.onDidChangeConfiguration.bind(this)));
        disposables.push(this.workspaceService.onDidChangeWorkspaceFolders(this.onWorkspaceFoldersChanged, this));
    }

    // When we change the current active document, we might need to recreate our language client.
    public async activate(resource: Resource): Promise<void> {
        this.resource = resource;

        // Do the same thing as a get.
        await this.get(resource);
    }

    public get(resource: Resource, interpreter?: PythonInterpreter): Promise<ILanguageServer> {
        // See if we already have it or not
        const key = this.getKey(resource, interpreter);
        let result: Promise<IStartableLanguageServer> | undefined = this.cache.get(key);
        if (!result) {
            result = this.createServer(resource, interpreter);
            this.cache.set(key, result);
        }
        return result;
    }

    public dispose() {
        if (this.currentServer) {
            this.currentServer.server.dispose();
        }
    }
    @swallowExceptions('Send telemetry for Language Server current selection')
    public async sendTelemetryForChosenLanguageServer(jediEnabled: boolean): Promise<void> {
        const state = this.stateFactory.createGlobalPersistentState<boolean | undefined>('SWITCH_LS', undefined);
        if (typeof state.value !== 'boolean') {
            await state.updateValue(jediEnabled);
        }
        if (state.value !== jediEnabled) {
            await state.updateValue(jediEnabled);
            sendTelemetryEvent(EventName.PYTHON_LANGUAGE_SERVER_CURRENT_SELECTION, undefined, { switchTo: jediEnabled });
        } else {
            sendTelemetryEvent(EventName.PYTHON_LANGUAGE_SERVER_CURRENT_SELECTION, undefined, { lsStartup: jediEnabled });
        }
    }

    /**
     * Checks if user has not manually set `jediEnabled` setting
     * @param resource
     * @returns `true` if user has NOT manually added the setting and is using default configuration, `false` if user has `jediEnabled` setting added
     */
    public isJediUsingDefaultConfiguration(resource: Resource): boolean {
        const settings = this.workspaceService.getConfiguration('python', resource).inspect<boolean>('jediEnabled');
        if (!settings) {
            traceError('WorkspaceConfiguration.inspect returns `undefined` for setting `python.jediEnabled`');
            return false;
        }
        return (settings.globalValue === undefined && settings.workspaceValue === undefined && settings.workspaceFolderValue === undefined);
    }

    /**
     * Checks if user is using Jedi as intellisense
     * @returns `true` if user is using jedi, `false` if user is using language server
     */
    public useJedi(): boolean {
        if (this.isJediUsingDefaultConfiguration(this.resource)) {
            if (this.abExperiments.inExperiment(LSEnabled)) {
                return false;
            }
            // Send telemetry if user is in control group
            this.abExperiments.sendTelemetryIfInExperiment(LSControl);
        }
        const enabled = this.configService.getSettings(this.resource).jediEnabled;
        this.sendTelemetryForChosenLanguageServer(enabled).ignoreErrors();
        return enabled;
    }

    protected onWorkspaceFoldersChanged() {
        //If an activated workspace folder was removed, dispose its activator
        const workspaceKeys = this.workspaceService.workspaceFolders!.map(workspaceFolder => this.getKey(workspaceFolder.uri));
        const activatedWkspcKeys = Array.from(this.cache.keys());
        const activatedWkspcFoldersRemoved = activatedWkspcKeys.filter(item => workspaceKeys.indexOf(item) < 0);
        if (activatedWkspcFoldersRemoved.length > 0) {
            for (const folder of activatedWkspcFoldersRemoved) {
                this.cache.get(folder)!.then(a => a.dispose()).ignoreErrors();
                this.cache!.delete(folder);
            }
        }
    }

    private async createServer(resource: Resource, interpreter?: PythonInterpreter): Promise<IStartableLanguageServer> {
        let jedi = this.useJedi();
        if (!jedi) {
            const diagnostic = await this.lsNotSupportedDiagnosticService.diagnose(undefined);
            this.lsNotSupportedDiagnosticService.handle(diagnostic).ignoreErrors();
            if (diagnostic.length) {
                sendTelemetryEvent(EventName.PYTHON_LANGUAGE_SERVER_PLATFORM_SUPPORTED, undefined, { supported: false });
                jedi = true;
            }
        } else if (this.jediServer) {
            return this.jediServer;
        }

        await this.logStartup(jedi);
        let serverName = jedi ? LanguageServerType.Jedi : LanguageServerType.DotNet;
        let server = this.serviceContainer.get<IStartableLanguageServer>(IStartableLanguageServer, serverName);
        this.currentServer = { jedi, server };

        try {
            await server.startup(resource);
        } catch (ex) {
            if (jedi) {
                throw ex;
            }
            jedi = true;
            await this.logStartup(jedi);
            serverName = LanguageServerType.Jedi;
            server = this.serviceContainer.get<IStartableLanguageServer>(IStartableLanguageServer, serverName);
            this.currentServer = { jedi, server };
            await server.startup(resource, interpreter);
        }

        // Jedi is always a singleton. Don't need to create it more than once.
        if (jedi) {
            this.jediServer = server;
        }

        return server;
    }

    private async logStartup(isJedi: boolean): Promise<void> {
        const outputLine = isJedi
            ? 'Starting Jedi Python language engine.'
            : 'Starting Microsoft Python language server.';
        this.output.appendLine(outputLine);
    }

    private async onDidChangeConfiguration(event: ConfigurationChangeEvent) {
        const workspacesUris: (Uri | undefined)[] = this.workspaceService.hasWorkspaceFolders
            ? this.workspaceService.workspaceFolders!.map(workspace => workspace.uri)
            : [undefined];
        if (workspacesUris.findIndex(uri => event.affectsConfiguration(`python.${jediEnabledSetting}`, uri)) === -1) {
            return;
        }
        const jedi = this.useJedi();
        if (this.currentServer && this.currentServer.jedi === jedi) {
            return;
        }

        const item = await this.appShell.showInformationMessage(
            localize.LanguageService.reloadMessage(),
            localize.LanguageService.reloadButton()
        );
        if (item === localize.LanguageService.reloadButton()) {
            this.serviceContainer.get<ICommandManager>(ICommandManager).executeCommand('workbench.action.reloadWindow');
        }
    }
    private getKey(resource: Resource, interpreter?: PythonInterpreter): string {
        const resourcePortion = this.workspaceService.getWorkspaceFolderIdentifier(resource, workspacePathNameForGlobalWorkspaces);
        const interperterPortion = interpreter ? interpreter.path : '';
        return `${resourcePortion}-${interperterPortion}`;
    }
}
