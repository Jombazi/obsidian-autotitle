export class CacheManager {
  /** Whether each note's body held a non-empty line at its last rename pass, which tells a body just deleted (renamed Untitled) from one that never had any; a flag rather than the text, so a bulk rename keeps no note text in memory */
  private hadBodyByPath = new Map<string, boolean>();
  private tempPaths = new Set<string>();

  // ==================== BODY PRESENCE ====================

  /**
   * Record whether a note's body held a non-empty line at this rename pass
   */
  setHadBody(filePath: string, hadBody: boolean): void {
    this.hadBodyByPath.set(filePath, hadBody);
  }

  /**
   * Whether a note's body held a non-empty line at its last recorded rename pass; false when none was recorded
   */
  hadBody(filePath: string): boolean {
    return this.hadBodyByPath.get(filePath) ?? false;
  }

  // ==================== TEMP PATHS (CONFLICT PREVENTION) ====================

  /**
   * Reserve a path to prevent conflicts
   */
  reservePath(path: string): void {
    this.tempPaths.add(path.toLowerCase());
  }

  /**
   * Release a reserved path
   */
  releasePath(path: string): void {
    this.tempPaths.delete(path.toLowerCase());
  }

  /**
   * Clear all reserved paths (for immediate cleanup after batch operations)
   */
  clearReservedPaths(): void {
    this.tempPaths.clear();
  }

  /**
   * Check if path is reserved
   */
  isPathReserved(path: string): boolean {
    return this.tempPaths.has(path.toLowerCase());
  }

  // ==================== FILE LIFECYCLE ====================

  /**
   * Notify cache of file deletion
   */
  notifyFileDeleted(path: string): void {
    this.hadBodyByPath.delete(path);
    this.releasePath(path);
  }

  /**
   * Update cache when file is renamed
   */
  notifyFileRenamed(oldPath: string, newPath: string): void {
    const hadBody = this.hadBodyByPath.get(oldPath);
    if (hadBody !== undefined) {
      this.hadBodyByPath.delete(oldPath);
      this.hadBodyByPath.set(newPath, hadBody);
    }

    // Release old path, reserve new path temporarily
    this.releasePath(oldPath);
    this.reservePath(newPath);
  }

  /**
   * Dispose of cache manager and clean up all resources
   */
  dispose(): void {
    this.hadBodyByPath.clear();
    this.tempPaths.clear();
  }
}
