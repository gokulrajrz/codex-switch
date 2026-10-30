/** Model the production lifecycle mutex for virtual filesystem adapters. */
const tails = new WeakMap<object, Promise<void>>()
export async function withTestMutex<T>(
  key: object,
  action: () => Promise<T>,
): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>((resolve) => {
    release = resolve
  })
  tails.set(key, next)
  await previous
  try {
    return await action()
  } finally {
    release()
  }
}
