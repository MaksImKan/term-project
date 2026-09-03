import { BadRequestException } from '@nestjs/common';
import { ListQuery, Page } from '../models';

// Cursor — непрозорий токен. Всередині лише offset, закодований у base64url.
// Клієнт його не парсить — просто повертає next_cursor назад.

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor?: string): number {
  if (cursor === undefined) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    const offset = Number(parsed.o);
    if (!Number.isInteger(offset) || offset < 0) throw new Error('bad');
    return offset;
  } catch {
    throw new BadRequestException("query parameter 'cursor' is not a valid opaque token");
  }
}

// defaultLimit приходить із типізованого конфіга (DEFAULT_PAGE_LIMIT),
// а не з магічної константи в коді.
export function paginate<T>(collection: T[], query: ListQuery, defaultLimit: number): Page<T> {
  const limit = query.limit === undefined ? defaultLimit : Number(query.limit);
  const offset = decodeCursor(query.cursor);
  const items = collection.slice(offset, offset + limit);
  const hasMore = offset + limit < collection.length;
  return { items, next_cursor: hasMore ? encodeCursor(offset + limit) : null };
}
