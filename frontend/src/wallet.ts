import {
  StellarWalletsKit,
  Networks as KitNetworks,
} from '@creit.tech/stellar-wallets-kit';
import { defaultModules } from '@creit.tech/stellar-wallets-kit/modules/utils';
import { FREIGHTER_ID } from '@creit.tech/stellar-wallets-kit/modules/freighter';

// Kit v2.x is all-static; init once at module load.
StellarWalletsKit.init({
  modules: defaultModules(),
  selectedWalletId: FREIGHTER_ID,
  network: KitNetworks.TESTNET,
});

/** Open the wallet picker modal, return the selected address. */
export async function pickWallet(): Promise<string> {
  const { address } = await StellarWalletsKit.authModal();
  return address;
}

/** Sign a transaction XDR with the currently selected wallet. */
export async function signXdr(xdr: string, address: string): Promise<string> {
  const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdr, {
    address,
    networkPassphrase: KitNetworks.TESTNET,
  });
  return signedTxXdr;
}

export async function disconnectWallet(): Promise<void> {
  try {
    await StellarWalletsKit.disconnect();
  } catch {
    /* some wallets don't expose disconnect; ignore */
  }
}
