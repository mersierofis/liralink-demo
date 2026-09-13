import { useCallback, useState } from 'react'
import { getWalletKit, WalletNetwork } from './walletKit'

export type WalletState = {
  address: string | null
  walletId: string | null
  connecting: boolean
  error: string | null
}

export function useWallet() {
  const [state, setState] = useState<WalletState>({
    address: null,
    walletId: null,
    connecting: false,
    error: null,
  })

  const connect = useCallback(async () => {
    const kit = getWalletKit()
    setState((s) => ({ ...s, connecting: true, error: null }))
    try {
      await kit.openModal({
        onWalletSelected: async (option) => {
          kit.setWallet(option.id)
          const { network, networkPassphrase } = await kit.getNetwork()
          if (/public|mainnet/i.test(network) || networkPassphrase === WalletNetwork.PUBLIC) {
            throw new Error('Wallet is on Mainnet. Switch Freighter to Testnet and try again.')
          }
          if (networkPassphrase !== WalletNetwork.TESTNET) {
            throw new Error('Wallet is not on Stellar Testnet. Switch Freighter to Testnet.')
          }
          const { address } = await kit.getAddress()
          setState({
            address,
            walletId: option.id,
            connecting: false,
            error: null,
          })
        },
        onClosed: () => {
          setState((s) => ({ ...s, connecting: false }))
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to connect wallet'
      setState((s) => ({ ...s, connecting: false, error: message }))
    }
  }, [])

  const disconnect = useCallback(() => {
    setState({ address: null, walletId: null, connecting: false, error: null })
  }, [])

  const signXdr = useCallback(
    async (xdr: string): Promise<string> => {
      if (!state.address) throw new Error('Connect a wallet first')
      const kit = getWalletKit()
      try {
        const { signedTxXdr } = await kit.signTransaction(xdr, {
          address: state.address,
          networkPassphrase: WalletNetwork.TESTNET,
        })
        return signedTxXdr
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/reject|denied|cancel|user/i.test(msg)) {
          throw new Error('Signature rejected in the wallet. Nothing was sent.')
        }
        throw err instanceof Error ? err : new Error(msg)
      }
    },
    [state.address],
  )

  return {
    address: state.address,
    walletId: state.walletId,
    connecting: state.connecting,
    error: state.error,
    connect,
    disconnect,
    signXdr,
  }
}
