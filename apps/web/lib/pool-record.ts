import { Connection, PublicKey } from '@solana/web3.js';

/** Mint-seeded PDA that stores the DAMM v2 pool for a graduated Mooner mint. */
export const MAGICPAD_PROGRAM_ID = new PublicKey('27HH4WUhKMmkza5NTpAjwhHkRwiPotPw55HxvjDRDsws');

export function poolRecordPda(mint: PublicKey, program = MAGICPAD_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), mint.toBuffer()],
    program,
  )[0];
}

export function decodePoolRecord(data: Uint8Array) {
  if (data.length < 80) throw new Error('pool record too small');
  const b = Buffer.from(data);
  return {
    launchId: Number(b.readBigUInt64LE(8)),
    mint: new PublicKey(b.subarray(16, 48)),
    pool: new PublicKey(b.subarray(48, 80)),
  };
}

export async function readRecordedPool(
  conn: Connection, mint: PublicKey,
): Promise<PublicKey | null> {
  const acc = await conn.getAccountInfo(poolRecordPda(mint), 'confirmed');
  if (!acc) return null;
  try {
    const rec = decodePoolRecord(acc.data);
    if (rec.pool.equals(PublicKey.default)) return null;
    return rec.pool;
  } catch {
    return null;
  }
}
