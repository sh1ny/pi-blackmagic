import * as fs from "node:fs";

/** The callback methods used by proper-lockfile, including its process-exit cleanup. */
export interface LockFilesystem {
  mkdir(path: fs.PathLike, callback: fs.NoParamCallback): void;
  rmdir(path: fs.PathLike, callback: fs.NoParamCallback): void;
  rmdirSync(path: fs.PathLike): void;
  stat(
    path: fs.PathLike,
    callback: (error: NodeJS.ErrnoException | null, stats: fs.Stats) => void,
  ): void;
  utimes(
    path: fs.PathLike,
    atime: number | string | Date,
    mtime: number | string | Date,
    callback: fs.NoParamCallback,
  ): void;
  realpath(
    path: fs.PathLike,
    callback: (error: NodeJS.ErrnoException | null, resolved: string) => void,
  ): void;
}

/**
 * Keep proper-lockfile's immutable Symbol precision cache on an ordinary local object,
 * never on a host/module filesystem proxy. Native filesystem operations are unchanged.
 */
export function createLockFilesystem(
  source: LockFilesystem = fs,
): LockFilesystem {
  return {
    mkdir: (path, callback) => source.mkdir(path, callback),
    rmdir: (path, callback) => source.rmdir(path, callback),
    rmdirSync: (path) => source.rmdirSync(path),
    stat: (path, callback) => source.stat(path, callback),
    utimes: (path, atime, mtime, callback) =>
      source.utimes(path, atime, mtime, callback),
    realpath: (path, callback) => source.realpath(path, callback),
  };
}
