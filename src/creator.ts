import * as fs from 'fs-extra';
import * as path from 'path';
import * as uuid from 'uuid/v4';
import { padStart } from 'lodash';

import { replaceToFile, replaceInString } from './utils/replace';
import { arrayToTree, addFilesToTree } from './utils/array-to-tree';
import { getDirectoryStructure } from './utils/walker';
import { Component, ComponentRef, Directory, File, FileFolderTree } from './interfaces';

const getTemplate = (name: string) => fs.readFileSync(path.join(__dirname, `../static/${name}.xml`), 'utf-8');
const ROOTDIR_NAME = 'APPLICATIONROOTDIRECTORY';

export interface MSICreatorOptions {
  appDirectory: string;
  outputDirectory: string;
  exe: string;
  description: string;
  version: string;
  name: string;
  shortName?: string;
  upgradeCode?: string;
  manufacturer: string;
  language?: number;
  programFilesFolderName?: string;
}

export class MSICreator {
  private files: Array<string> = [];
  private directories: Array<string> = [];
  private tree: FileFolderTree;
  private components: Array<Component> = [];

  public componentTemplate = getTemplate('component');
  public componentRefTemplate = getTemplate('component-ref');
  public directoryTemplate = getTemplate('directory');
  public wixTemplate = getTemplate('wix');

  public readonly appDirectory: string;
  public readonly outputDirectory: string;
  public readonly exe: string;
  public readonly description: string;
  public readonly version: string;
  public readonly name: string;
  public readonly shortName: string;
  public readonly upgradeCode: string;
  public readonly manufacturer: string;
  public readonly language: number;
  public readonly programFilesFolderName: string;

  constructor(options: MSICreatorOptions) {
    this.appDirectory = options.appDirectory;
    this.outputDirectory = options.outputDirectory;
    this.exe = options.exe.replace(/\.exe$/, '');
    this.description = options.description;
    this.version = options.version;
    this.name = options.name;
    this.upgradeCode = options.upgradeCode || uuid();
    this.manufacturer = options.manufacturer;
    this.language = options.language || 1033;
    this.shortName = options.shortName || options.name;
    this.programFilesFolderName = options.programFilesFolderName || options.name;
  }

  public async create() {
    const { files, directories } = await getDirectoryStructure(this.appDirectory);

    this.files = files;
    this.directories = directories;
    this.tree = this.getTree();

    await this.createWxs();
  }

  private async createWxs() {
    const target = path.join(this.outputDirectory, `${this.exe}.wxs`);
    const base = path.basename(this.appDirectory);
    const directories = await this.getDirectoryForTree(
      this.tree, base, 8, ROOTDIR_NAME, this.programFilesFolderName);
    const componentRefs = await this.getComponentRefs();
    const replacements = {
      '{{ApplicationName}}': this.name,
      '{{UpgradeCode}}': this.upgradeCode,
      '{{Version}}': this.version,
      '{{Manufacturer}}': this.manufacturer,
      '{{Language}}': this.language.toString(10),
      '{{ApplicationDescription}}': this.description,
      '{{ApplicationBinary}}': this.exe,
      '{{ApplicationShortName}}': this.shortName,
      '{{ApplicationShortcutGuid}}': uuid(),
      '<!-- {{Directories}} -->': directories,
      '<!-- {{ComponentRefs}} -->': componentRefs.map(({ xml }) => xml).join('\n')
    }

    await replaceToFile(this.wixTemplate, target, replacements);
  }

  /**
   * Creates the XML component for Wix <Directory> elements,
   * including children
   *
   * @param {FileFolderTree} tree
   * @param {string} treePath
   * @param {number} [indent=0]
   * @returns {string}
   */
  private getDirectoryForTree(tree: FileFolderTree, treePath: string, indent: number = 0, id?: string, name?: string): string {
    const childDirectories = Object.keys(tree)
      .filter((k) => !k.startsWith('__ELECTRON_WIX_MSI'))
      .map((k) => {
        return this.getDirectoryForTree(
          tree[k] as FileFolderTree,
          (tree[k] as FileFolderTree).__ELECTRON_WIX_MSI_PATH__,
          indent + 2
        )}
      );
    const childFiles = tree.__ELECTRON_WIX_MSI_FILES__
      .map((file) => {
        const component = this.getComponent(file, indent + 2);
        this.components.push(component);
        return component.xml;
      });

    const children: string = [childDirectories.join('\n'), childFiles.join('\n')].join('');

    return replaceInString(this.directoryTemplate, {
      '<!-- {{I}} -->': indent > 0 ? padStart('', indent) : '',
      '{{DirectoryId}}': id || this.getComponentId(treePath),
      '{{DirectoryName}}': name || path.basename(treePath),
      '<!-- {{Children}} -->': children
    });
  }

  /**
   * Get a FileFolderTree for all files that need to be installed.
   *
   * @returns {FileFolderTree}
   */
  private getTree(): FileFolderTree {
    const root = this.appDirectory;
    const folderTree = arrayToTree(this.directories, root);
    const fileFolderTree = addFilesToTree(folderTree, this.files, root);

    return fileFolderTree;
  }

  /**
   * Creates Wix <ComponentRefs> for all components.
   *
   * @returns {Promise<Array<string>>}
   */
  private getComponentRefs(indent: number = 6): Array<ComponentRef> {
    return this.components.map(({ componentId }) => {
      const xml = replaceInString(this.componentRefTemplate, {
        '<!-- {{I}} -->': indent > 0 ? padStart('', indent) : '',
        '{{ComponentId}}': componentId
      });

      return { componentId, xml };
    });
  }

  /**
   * Creates Wix <Components> for all files.
   *
   * @param {File}
   * @returns {Component}
   */
  private getComponent(file: File, indent: number = 0): Component {
    const guid = uuid();
    const componentId = this.getComponentId(file.path);
    const xml = replaceInString(this.componentTemplate, {
      '<!-- {{I}} -->': indent > 0 ? padStart('', indent) : '',
      '{{ComponentId}}': componentId,
      '{{FileId}}': componentId,
      '{{Name}}': file.name,
      '{{Guid}}': guid,
      '{{SourcePath}}': file.path
    });

    return { guid, componentId, xml, file }
  }

  /**
   * Creates a usable component id to use with Wix "id" fields
   *
   * @private
   * @param {string} filePath
   * @returns {string} componentId
   */
  private getComponentId(filePath: string): string {
    const pathId = filePath
      .replace(this.appDirectory, '')
      .replace(/^\\|\//g, '');
    const id = (pathId.length > 72)
      ? `${path.basename(filePath).slice(0, 35)}_${uuid()}`
      : pathId;

    return id.replace(/[^A-Za-z0-9_\.]/g, '_');
  }
}