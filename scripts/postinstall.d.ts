export interface WindowsInstallOptions {
  platform: NodeJS.Platform | string;
  global: boolean;
  packageRoot: string;
  prefix: string;
}

export function installWindowsRemoteHelper(options: WindowsInstallOptions): boolean;
