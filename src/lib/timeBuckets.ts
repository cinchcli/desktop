export type TimeBucket = 'Today' | 'Yesterday' | 'This week' | 'Older';

export interface BucketGroup<T> {
  bucket: TimeBucket;
  items: T[];
}

export interface Timestamped {
  created_at: number; // unix seconds
}

const ORDER: TimeBucket[] = ['Today', 'Yesterday', 'This week', 'Older'];

const ONE_DAY = 86_400;

function bucketOf(secondsAgo: number): TimeBucket {
  if (secondsAgo < ONE_DAY) return 'Today';
  if (secondsAgo < 2 * ONE_DAY) return 'Yesterday';
  if (secondsAgo < 7 * ONE_DAY) return 'This week';
  return 'Older';
}

export function groupByTimeBucket<T extends Timestamped>(
  items: T[],
  nowUnixSeconds: number = Math.floor(Date.now() / 1000)
): BucketGroup<T>[] {
  if (items.length === 0) return [];
  const map = new Map<TimeBucket, T[]>();
  for (const it of items) {
    const b = bucketOf(nowUnixSeconds - it.created_at);
    const arr = map.get(b);
    if (arr) arr.push(it);
    else map.set(b, [it]);
  }
  return ORDER.filter(b => map.has(b)).map(bucket => ({
    bucket,
    items: map.get(bucket)!,
  }));
}
