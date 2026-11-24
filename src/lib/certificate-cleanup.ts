import { type DbPool, queryOne, withTransaction } from "./db/connection.ts";
import type { StorageService } from "./services/storage.ts";

/**
 * Removes the certificates a void or a decline stored before it failed.
 *
 * The files have fixed keys, and whatever ends an envelope stores them while
 * it holds the envelope's row. A statement that fails inside a transaction
 * makes Postgres give that row up at once, before the failure is even
 * reported, so by now something else may have ended the envelope and stored
 * certificates of its own under the same keys. The row is therefore taken
 * again, and the files are removed only while the envelope is still out for
 * signature: then nothing has claimed them, and nothing can while the row is
 * held.
 *
 * If the row cannot be taken the files stay. A file nothing points at is
 * written over by whatever ends the envelope next; a certificate deleted
 * from under a finished envelope is gone for good.
 */
export async function removeUnclaimedEnvelopeCertificates(
  {
    envelopeId,
    keys,
    storageService,
  }: {
    envelopeId: string;
    keys: readonly string[];
    storageService: Pick<StorageService, "deleteObject">;
  },
  database: DbPool,
): Promise<void> {
  if (keys.length === 0) {
    return;
  }

  await withTransaction(async (tx) => {
    const envelope = await queryOne<{ status: string }>(
      tx,
      `
        SELECT status
        FROM envelopes
        WHERE id = $1
        FOR NO KEY UPDATE
      `,
      [envelopeId],
    );

    if (envelope && envelope.status !== "sent") {
      return;
    }

    await Promise.all(
      keys.map((key) =>
        storageService.deleteObject(key).catch(() => undefined),
      ),
    );
  }, database).catch(() => undefined);
}
