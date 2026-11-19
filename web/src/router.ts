export function go(path: string): void {
  location.hash = '#' + path;
}

export function currentBookId(): string | null {
  return sessionStorage.getItem('bs.currentBook');
}
