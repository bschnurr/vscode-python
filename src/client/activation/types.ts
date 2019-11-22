// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';

import { SemVer } from 'semver';
import {
    CodeLensProvider,
    CompletionItemProvider,
    DefinitionProvider,
    DocumentSymbolProvider,
    Event,
    HoverProvider,
    ReferenceProvider,
    RenameProvider,
    SignatureHelpProvider,
    TextDocument,
    TextDocumentContentChangeEvent
} from 'vscode';
import { LanguageClient, LanguageClientOptions } from 'vscode-languageclient';

import { NugetPackage } from '../common/nuget/types';
import { IDisposable, IOutputChannel, LanguageServerDownloadChannels, Resource } from '../common/types';
import { PythonInterpreter } from '../interpreter/contracts';

export const IExtensionActivationManager = Symbol('IExtensionActivationManager');
/**
 * Responsible for activation of extension.
 *
 * @export
 * @interface IExtensionActivationManager
 * @extends {IDisposable}
 */
export interface IExtensionActivationManager extends IDisposable {
    /**
     * Method invoked when extension activates (invoked once).
     *
     * @returns {Promise<void>}
     * @memberof IExtensionActivationManager
     */
    activate(): Promise<void>;
    /**
     * Method invoked when a workspace is loaded.
     * This is where we place initialization scripts for each workspace.
     * (e.g. if we need to run code for each workspace, then this is where that happens).
     *
     * @param {Resource} resource
     * @returns {Promise<void>}
     * @memberof IExtensionActivationManager
     */
    activateWorkspace(resource: Resource): Promise<void>;
}

export const IExtensionActivationService = Symbol('IExtensionActivationService');
/**
 * Classes implementing this interface will have their `activate` methods
 * invoked for every workspace folder (in multi-root workspace folders) during the activation of the extension.
 * This is a great hook for extension activation code, i.e. you don't need to modify
 * the `extension.ts` file to invoke some code when extension gets activated.
 * @export
 * @interface IExtensionActivationService
 */
export interface IExtensionActivationService {
    activate(resource: Resource): Promise<void>;
}

export enum LanguageServerType {
    Jedi = 'Jedi',
    DotNet = 'DotNet'
}

export const ILanguageServerCache = Symbol('ILanguageServerCache');
export interface ILanguageServerCache {
    get(resource: Resource, interpreter?: PythonInterpreter): Promise<ILanguageServer>;
}

// tslint:disable-next-line: interface-name
export interface DocumentHandler {
    handleOpen(document: TextDocument): void;
    handleChanges(document: TextDocument, changes: TextDocumentContentChangeEvent[]): void;
}

export interface ILanguageServer extends
    RenameProvider,
    DefinitionProvider,
    HoverProvider,
    ReferenceProvider,
    CompletionItemProvider,
    CodeLensProvider,
    DocumentSymbolProvider,
    SignatureHelpProvider,
    Partial<DocumentHandler> {
}

export const IStartableLanguageServer = Symbol('IStartableLanguageServer');
export interface IStartableLanguageServer extends ILanguageServer, IDisposable {
    startup(resource: Resource, interpreter?: PythonInterpreter): Promise<void>;
}

export type FolderVersionPair = { path: string; version: SemVer };
export const ILanguageServerFolderService = Symbol('ILanguageServerFolderService');

export interface ILanguageServerFolderService {
    getLanguageServerFolderName(resource: Resource): Promise<string>;
    getLatestLanguageServerVersion(resource: Resource): Promise<NugetPackage | undefined>;
    getCurrentLanguageServerDirectory(): Promise<FolderVersionPair | undefined>;
}

export const ILanguageServerDownloader = Symbol('ILanguageServerDownloader');

export interface ILanguageServerDownloader {
    downloadLanguageServer(destinationFolder: string, resource: Resource): Promise<void>;
}

export const ILanguageServerPackageService = Symbol('ILanguageServerPackageService');
export interface ILanguageServerPackageService {
    getNugetPackageName(): string;
    getLatestNugetPackageVersion(resource: Resource): Promise<NugetPackage>;
    getLanguageServerDownloadChannel(): LanguageServerDownloadChannels;
}

export const MajorLanguageServerVersion = Symbol('MajorLanguageServerVersion');
export const IDownloadChannelRule = Symbol('IDownloadChannelRule');
export interface IDownloadChannelRule {
    shouldLookForNewLanguageServer(currentFolder?: FolderVersionPair): Promise<boolean>;
}
export const ILanguageServerCompatibilityService = Symbol('ILanguageServerCompatibilityService');
export interface ILanguageServerCompatibilityService {
    isSupported(): Promise<boolean>;
}
export enum LanguageClientFactory {
    base = 'base',
    simple = 'simple',
    downloaded = 'downloaded'
}
export const ILanguageClientFactory = Symbol('ILanguageClientFactory');
export interface ILanguageClientFactory {
    createLanguageClient(resource: Resource, interpreter: PythonInterpreter | undefined, clientOptions: LanguageClientOptions, env?: NodeJS.ProcessEnv): Promise<LanguageClient>;
}
export const ILanguageServerAnalysisOptions = Symbol('ILanguageServerAnalysisOptions');
export interface ILanguageServerAnalysisOptions extends IDisposable {
    readonly onDidChange: Event<void>;
    initialize(resource: Resource, interpreter?: PythonInterpreter): Promise<void>;
    getAnalysisOptions(): Promise<LanguageClientOptions>;
}

export const ILanguageServerExtension = Symbol('ILanguageServerExtension');
export interface ILanguageServerExtension extends IDisposable {
    readonly invoked: Event<void>;
    loadExtensionArgs?: {};
    register(): void;
}

export enum PlatformName {
    Windows32Bit = 'win-x86',
    Windows64Bit = 'win-x64',
    Mac64Bit = 'osx-x64',
    Linux64Bit = 'linux-x64'
}
export const IPlatformData = Symbol('IPlatformData');
export interface IPlatformData {
    readonly platformName: PlatformName;
    readonly engineDllName: string;
    readonly engineExecutableName: string;
}

export const ILanguageServerOutputChannel = Symbol('ILanguageServerOutputChannel');
export interface ILanguageServerOutputChannel {
    /**
     * Creates output channel if necessary and returns it
     *
     * @type {IOutputChannel}
     * @memberof ILanguageServerOutputChannel
     */
    readonly channel: IOutputChannel;
}

export const IExtensionSingleActivationService = Symbol('IExtensionSingleActivationService');
/**
 * Classes implementing this interface will have their `activate` methods
 * invoked during the activation of the extension.
 * This is a great hook for extension activation code, i.e. you don't need to modify
 * the `extension.ts` file to invoke some code when extension gets activated.
 * @export
 * @interface IExtensionSingleActivationService
 */
export interface IExtensionSingleActivationService {
    activate(): Promise<void>;
}
