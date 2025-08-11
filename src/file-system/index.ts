/**
 * File System Module
 * Public API exports
 */

export * from './types';
export { fileSystemService } from './service';
export { terminalService } from './terminal';
export * from './handlers';

import { Router } from '../server/router';
import {
  handleList,
  handleRead,
  handleWrite,
  handleDelete,
  handleSearch,
  handleMetadata,
  handleTerminal,
  handleHome,
  handleTelescopeSearch,
} from './handlers';

/**
 * Register all file system routes
 */
export function registerFileSystemRoutes(router: Router): void {
  // File operations
  router.get('/list', handleList);
  router.get('/read', handleRead);
  router.post('/write', handleWrite);
  router.delete('/delete', handleDelete);
  router.get('/search', handleSearch);
  router.get('/telescope', handleTelescopeSearch);
  router.get('/metadata', handleMetadata);
  router.get('/home', handleHome);
  
  // Terminal
  router.post('/terminal', handleTerminal);
}