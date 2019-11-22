// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import '../../../client/common/extensions';

import { expect } from 'chai';
import { anything, instance, mock, verify, when } from 'ts-mockito';
import * as typemoq from 'typemoq';
import { Uri } from 'vscode';
import { Disposable, LanguageClient, LanguageClientOptions } from 'vscode-languageclient';

import { LanguageServerAnalysisOptions } from '../../../client/activation/languageServer/analysisOptions';
import { DotNetLanguageServer } from '../../../client/activation/languageServer/dotNetLanguageServer';
import { BaseLanguageClientFactory } from '../../../client/activation/languageServer/languageClientFactory';
import {
    LanguageServerExtension,
    LoadLanguageServerExtensionCommand
} from '../../../client/activation/languageServer/languageServerExtension';
import {
    ILanguageClientFactory,
    ILanguageServerAnalysisOptions,
    ILanguageServerDownloader,
    ILanguageServerExtension,
    ILanguageServerFolderService
} from '../../../client/activation/types';
import { ICommandManager } from '../../../client/common/application/types';
import { IFileSystem } from '../../../client/common/platform/types';
import { IConfigurationService, IDisposable, IPythonSettings } from '../../../client/common/types';
import { sleep } from '../../../client/common/utils/async';
import { UnitTestManagementService } from '../../../client/testing/main';
import { ITestManagementService } from '../../../client/testing/types';

//tslint:disable:no-require-imports no-require-imports no-var-requires no-any no-unnecessary-class max-func-body-length

suite('Language Server - LanguageServer', () => {
    class LanguageServerTest extends DotNetLanguageServer {
        // tslint:disable-next-line:no-unnecessary-override
        public async registerTestServices() {
            return super.registerTestServices();
        }
    }
    let clientFactory: ILanguageClientFactory;
    let server: LanguageServerTest;
    let client: typemoq.IMock<LanguageClient>;
    let testManager: ITestManagementService;
    let configService: typemoq.IMock<IConfigurationService>;
    let fileSystem: typemoq.IMock<IFileSystem>;
    let commandManager: typemoq.IMock<ICommandManager>;
    let analysisOptions: ILanguageServerAnalysisOptions;
    let lsExtension: ILanguageServerExtension;
    let lsDownloader: typemoq.IMock<ILanguageServerDownloader>;
    let lsFolderService: typemoq.IMock<ILanguageServerFolderService>;
    let lsExtensionCallback: (args: any) => void;
    let onChangeAnalysisHandler: Function;
    const languageClientOptions = ({ x: 1 } as any) as LanguageClientOptions;
    let analysisHandlerRegistered = false;
    setup(() => {
        client = typemoq.Mock.ofType<LanguageClient>();
        clientFactory = mock(BaseLanguageClientFactory);
        testManager = mock(UnitTestManagementService);
        configService = typemoq.Mock.ofType<IConfigurationService>();
        analysisOptions = mock(LanguageServerAnalysisOptions);
        fileSystem = typemoq.Mock.ofType<IFileSystem>();
        lsDownloader = typemoq.Mock.ofType<ILanguageServerDownloader>();
        lsFolderService = typemoq.Mock.ofType<ILanguageServerFolderService>();

        commandManager = typemoq.Mock.ofType<ICommandManager>();
        commandManager.setup(c => c.registerCommand(typemoq.It.isAny(), typemoq.It.isAny(), typemoq.It.isAny())).returns((command, callback) => {
            if (command === LoadLanguageServerExtensionCommand) {
                lsExtensionCallback = callback;
            }
            return typemoq.Mock.ofType<Disposable>().object;
        });
        commandManager.setup(c => c.executeCommand(typemoq.It.isAny(), typemoq.It.isAny())).returns((c, a) => {
            if (c === LoadLanguageServerExtensionCommand && lsExtensionCallback) {
                lsExtensionCallback(a);
            }
            return Promise.resolve();
        });
        lsExtension = new LanguageServerExtension(commandManager.object);

        server = new LanguageServerTest(
            instance(clientFactory),
            instance(testManager),
            configService.object,
            commandManager.object,
            analysisOptions,
            lsExtension,
            fileSystem.object,
            lsDownloader.object,
            lsFolderService.object
        );
    });
    teardown(() => {
        client.setup(c => c.stop()).returns(() => Promise.resolve());
        server.dispose();
    });
    test('Loading extension will not throw an error if not activated', () => {
        expect(() => commandManager.object.executeCommand(LoadLanguageServerExtensionCommand)).not.throw();
    });
    test('Loading extension will not throw an error if not activated but after it loads message will be sent', async () => {
        const loadExtensionArgs = { x: 1 };

        expect(() => commandManager.object.executeCommand(LoadLanguageServerExtensionCommand, { a: '2' })).not.throw();

        client.verify(c => c.sendRequest(typemoq.It.isAny(), typemoq.It.isAny()), typemoq.Times.never());

        const uri = Uri.file(__filename);
        const options = typemoq.Mock.ofType<LanguageClientOptions>().object;

        const pythonSettings = typemoq.Mock.ofType<IPythonSettings>();
        pythonSettings
            .setup(p => p.downloadLanguageServer)
            .returns(() => true);
        configService
            .setup(c => c.getSettings(uri))
            .returns(() => pythonSettings.object);

        const onTelemetryDisposable = typemoq.Mock.ofType<IDisposable>();
        client
            .setup(c => c.onTelemetry(typemoq.It.isAny()))
            .returns(() => onTelemetryDisposable.object);

        client.setup(c => (c as any).then).returns(() => undefined);
        when(clientFactory.createLanguageClient(uri, undefined, options)).thenResolve(client.object);
        const startDisposable = typemoq.Mock.ofType<IDisposable>();
        client.setup(c => c.stop()).returns(() => Promise.resolve());
        client
            .setup(c => c.start())
            .returns(() => startDisposable.object)
            .verifiable(typemoq.Times.once());
        client
            .setup(c =>
                c.sendRequest(typemoq.It.isValue('python/loadExtension'), typemoq.It.isValue(loadExtensionArgs))
            )
            .returns(() => Promise.resolve(undefined) as any);

        expect(() => commandManager.object.executeCommand(LoadLanguageServerExtensionCommand, loadExtensionArgs)).not.throw();
        client.verify(c => c.sendRequest(typemoq.It.isAny(), typemoq.It.isAny()), typemoq.Times.never());
        client
            .setup(c => c.initializeResult)
            .returns(() => false as any)
            .verifiable(typemoq.Times.once());

        server.startup(uri, undefined).ignoreErrors();

        // Even though server has started request should not yet be sent out.
        // Not until language client has initialized.
        expect(() => commandManager.object.executeCommand(LoadLanguageServerExtensionCommand, loadExtensionArgs)).not.throw();
        client.verify(c => c.sendRequest(typemoq.It.isAny(), typemoq.It.isAny()), typemoq.Times.never());

        // // Initialize language client and verify that the request was sent out.
        client
            .setup(c => c.initializeResult)
            .returns(() => true as any)
            .verifiable(typemoq.Times.once());
        await sleep(120);

        verify(testManager.activate(anything())).once();
        client.verify(c => c.sendRequest(typemoq.It.isAny(), typemoq.It.isAny()), typemoq.Times.atLeast(2));
    });
    test('Send telemetry when LS has started and disposes appropriately', async () => {
        const loadExtensionArgs = { x: 1 };
        const uri = Uri.file(__filename);
        const options = typemoq.Mock.ofType<LanguageClientOptions>().object;

        const pythonSettings = typemoq.Mock.ofType<IPythonSettings>();
        pythonSettings
            .setup(p => p.downloadLanguageServer)
            .returns(() => true);
        configService
            .setup(c => c.getSettings(uri))
            .returns(() => pythonSettings.object);

        const onTelemetryDisposable = typemoq.Mock.ofType<IDisposable>();
        client
            .setup(c => c.onTelemetry(typemoq.It.isAny()))
            .returns(() => onTelemetryDisposable.object);

        client.setup(c => (c as any).then).returns(() => undefined);
        when(clientFactory.createLanguageClient(uri, undefined, options)).thenResolve(client.object);
        const startDisposable = typemoq.Mock.ofType<IDisposable>();
        client.setup(c => c.stop()).returns(() => Promise.resolve());
        client
            .setup(c => c.start())
            .returns(() => startDisposable.object)
            .verifiable(typemoq.Times.once());
        client
            .setup(c =>
                c.sendRequest(typemoq.It.isValue('python/loadExtension'), typemoq.It.isValue(loadExtensionArgs))
            )
            .returns(() => Promise.resolve(undefined) as any);

        expect(() => commandManager.object.executeCommand(LoadLanguageServerExtensionCommand, loadExtensionArgs)).not.throw();
        client.verify(c => c.sendRequest(typemoq.It.isAny(), typemoq.It.isAny()), typemoq.Times.never());
        client
            .setup(c => c.initializeResult)
            .returns(() => false as any)
            .verifiable(typemoq.Times.once());

        const promise = server.startup(uri);

        // Even though server has started request should not yet be sent out.
        // Not until language client has initialized.
        expect(() => commandManager.object.executeCommand(LoadLanguageServerExtensionCommand, loadExtensionArgs)).not.throw();
        client.verify(c => c.sendRequest(typemoq.It.isAny(), typemoq.It.isAny()), typemoq.Times.never());

        // // Initialize language client and verify that the request was sent out.
        client
            .setup(c => c.initializeResult)
            .returns(() => true as any)
            .verifiable(typemoq.Times.once());
        await sleep(120);

        verify(testManager.activate(anything())).once();
        expect(() => commandManager.object.executeCommand(LoadLanguageServerExtensionCommand, loadExtensionArgs)).to.not.throw();
        client.verify(c => c.sendRequest(typemoq.It.isAny(), typemoq.It.isAny()), typemoq.Times.once());
        client.verify(c => c.stop(), typemoq.Times.never());

        await promise;
        server.dispose();

        client.verify(c => c.stop(), typemoq.Times.once());
        startDisposable.verify(d => d.dispose(), typemoq.Times.once());
    });
    test('Ensure Errors raised when starting test manager are not bubbled up', async () => {
        await server.registerTestServices();
    });
    test('Register telemetry handler if LS was downloadeded', async () => {
        client.verify(c => c.sendRequest(typemoq.It.isAny(), typemoq.It.isAny()), typemoq.Times.never());

        const uri = Uri.file(__filename);
        const options = typemoq.Mock.ofType<LanguageClientOptions>().object;

        const pythonSettings = typemoq.Mock.ofType<IPythonSettings>();
        pythonSettings
            .setup(p => p.downloadLanguageServer)
            .returns(() => true)
            .verifiable(typemoq.Times.once());
        configService
            .setup(c => c.getSettings(uri))
            .returns(() => pythonSettings.object)
            .verifiable(typemoq.Times.once());

        const onTelemetryDisposable = typemoq.Mock.ofType<IDisposable>();
        client
            .setup(c => c.onTelemetry(typemoq.It.isAny()))
            .returns(() => onTelemetryDisposable.object)
            .verifiable(typemoq.Times.once());

        client.setup(c => (c as any).then).returns(() => undefined);
        when(clientFactory.createLanguageClient(uri, undefined, options)).thenResolve(client.object);
        const startDisposable = typemoq.Mock.ofType<IDisposable>();
        client.setup(c => c.stop()).returns(() => Promise.resolve());
        client
            .setup(c => c.start())
            .returns(() => startDisposable.object)
            .verifiable(typemoq.Times.once());

        server.startup(uri).ignoreErrors();

        // Initialize language client and verify that the request was sent out.
        client
            .setup(c => c.initializeResult)
            .returns(() => true as any)
            .verifiable(typemoq.Times.once());
        await sleep(120);

        verify(testManager.activate(anything())).once();

        client.verify(c => c.onTelemetry(typemoq.It.isAny()), typemoq.Times.once());
        pythonSettings.verifyAll();
        configService.verifyAll();
    });
    test('Do not register telemetry handler if LS was not downloadeded', async () => {
        client.verify(c => c.sendRequest(typemoq.It.isAny(), typemoq.It.isAny()), typemoq.Times.never());

        const uri = Uri.file(__filename);
        const options = typemoq.Mock.ofType<LanguageClientOptions>().object;

        const pythonSettings = typemoq.Mock.ofType<IPythonSettings>();
        pythonSettings
            .setup(p => p.downloadLanguageServer)
            .returns(() => false)
            .verifiable(typemoq.Times.once());
        configService
            .setup(c => c.getSettings(uri))
            .returns(() => pythonSettings.object)
            .verifiable(typemoq.Times.once());

        const onTelemetryDisposable = typemoq.Mock.ofType<IDisposable>();
        client
            .setup(c => c.onTelemetry(typemoq.It.isAny()))
            .returns(() => onTelemetryDisposable.object)
            .verifiable(typemoq.Times.once());

        client.setup(c => (c as any).then).returns(() => undefined);
        when(clientFactory.createLanguageClient(uri, undefined, options)).thenResolve(client.object);
        const startDisposable = typemoq.Mock.ofType<IDisposable>();
        client.setup(c => c.stop()).returns(() => Promise.resolve());
        client
            .setup(c => c.start())
            .returns(() => startDisposable.object)
            .verifiable(typemoq.Times.once());

        server.startup(uri).ignoreErrors();

        // Initialize language client and verify that the request was sent out.
        client
            .setup(c => c.initializeResult)
            .returns(() => true as any)
            .verifiable(typemoq.Times.once());
        await sleep(120);

        verify(testManager.activate(anything())).once();

        client.verify(c => c.onTelemetry(typemoq.It.isAny()), typemoq.Times.never());
        pythonSettings.verifyAll();
        configService.verifyAll();
    });
    test('Do not register services if languageClient is disposed while waiting for it to start', async () => {
        const uri = Uri.file(__filename);
        const options = typemoq.Mock.ofType<LanguageClientOptions>().object;

        const pythonSettings = typemoq.Mock.ofType<IPythonSettings>();
        pythonSettings
            .setup(p => p.downloadLanguageServer)
            .returns(() => false)
            .verifiable(typemoq.Times.never());
        configService
            .setup(c => c.getSettings(uri))
            .returns(() => pythonSettings.object)
            .verifiable(typemoq.Times.never());

        client.setup(c => (c as any).then).returns(() => undefined);
        client
            .setup(c => c.initializeResult)
            .returns(() => undefined)
            .verifiable(typemoq.Times.atLeastOnce());
        when(clientFactory.createLanguageClient(uri, undefined, options)).thenResolve(client.object);
        const startDisposable = typemoq.Mock.ofType<IDisposable>();
        client.setup(c => c.stop()).returns(() => Promise.resolve());
        client
            .setup(c => c.start())
            .returns(() => startDisposable.object)
            .verifiable(typemoq.Times.once());

        const promise = server.startup(uri);
        // Wait until we start ls client and check if it is ready.
        await sleep(200);
        // Confirm we checked if it is ready.
        client.verifyAll();
        // Now dispose the language client.
        server.dispose();
        // Wait until we check if it is ready.
        await sleep(500);

        // Promise should resolve without any errors.
        await promise;

        verify(testManager.activate(anything())).never();
        client.verify(c => c.onTelemetry(typemoq.It.isAny()), typemoq.Times.never());
        pythonSettings.verifyAll();
        configService.verifyAll();
    });

    [undefined, Uri.file(__filename)].forEach(resource => {
        async function startLanguageServer() {
            const analysisChangeFn = (handler: Function) => {
                analysisHandlerRegistered = true;
                onChangeAnalysisHandler = handler;
            };
            when(analysisOptions.initialize(resource)).thenResolve();
            when(analysisOptions.getAnalysisOptions()).thenResolve(languageClientOptions);
            when(analysisOptions.onDidChange).thenReturn(analysisChangeFn as any);

            await server.startup(resource);

            verify(analysisOptions.initialize(resource)).once();
            verify(analysisOptions.getAnalysisOptions()).once();
            // tslint:disable-next-line: no-unused-expression chai-vague-errors
            expect(analysisHandlerRegistered).to.be.true;
        }
        test('Start must register handlers and initialize analysis options', async () => {
            await startLanguageServer();
            server.dispose();
        });
        test('Attempting to start LS will throw an exception', async () => {
            await startLanguageServer();
            await expect(server.startup(resource)).to.eventually.be.rejectedWith('Language Server already started');
        });
        test('Changes in analysis options must restart LS', async () => {
            await startLanguageServer();

            await onChangeAnalysisHandler.call(server);
            await sleep(1);
            verify(analysisOptions.getAnalysisOptions()).twice();
        });
        test('Changes in analysis options must throttled when restarting LS', async () => {
            await startLanguageServer();

            await onChangeAnalysisHandler.call(server);
            await onChangeAnalysisHandler.call(server);
            await onChangeAnalysisHandler.call(server);
            await onChangeAnalysisHandler.call(server);
            await Promise.all([
                onChangeAnalysisHandler.call(server),
                onChangeAnalysisHandler.call(server),
                onChangeAnalysisHandler.call(server),
                onChangeAnalysisHandler.call(server)
            ]);
            await sleep(1);
            verify(analysisOptions.getAnalysisOptions()).twice();
        });
        test('Multiple changes in analysis options must restart LS twice', async () => {
            await startLanguageServer();

            await onChangeAnalysisHandler.call(server);
            await onChangeAnalysisHandler.call(server);
            await onChangeAnalysisHandler.call(server);
            await onChangeAnalysisHandler.call(server);
            await Promise.all([
                onChangeAnalysisHandler.call(server),
                onChangeAnalysisHandler.call(server),
                onChangeAnalysisHandler.call(server),
                onChangeAnalysisHandler.call(server)
            ]);
            await sleep(1);

            verify(analysisOptions.getAnalysisOptions()).twice();

            await onChangeAnalysisHandler.call(server);
            await onChangeAnalysisHandler.call(server);
            await onChangeAnalysisHandler.call(server);
            await onChangeAnalysisHandler.call(server);
            await Promise.all([
                onChangeAnalysisHandler.call(server),
                onChangeAnalysisHandler.call(server),
                onChangeAnalysisHandler.call(server),
                onChangeAnalysisHandler.call(server)
            ]);
            await sleep(1);

            verify(analysisOptions.getAnalysisOptions()).thrice();
        });
    });
});
