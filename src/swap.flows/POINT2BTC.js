import debug from 'debug'
import crypto from 'bitcoinjs-lib/src/crypto' // move to BtcSwap
import SwapApp, { constants } from 'swap.app'
import { Flow } from 'swap.swap'


class POINT2BTC extends Flow {

  static getName() {
    return `${this.getFromName()}2${this.getToName()}`
  }
  static getFromName() {
    return constants.COINS.point
  }
  static getToName() {
    return constants.COINS.btc
  }
  constructor(swap) {
    super(swap)

    this._flowName = POINT2BTC.getName()

    this.stepNumbers = {
      'sign': 1,
      'wait-lock-btc': 2,
      'verify-script': 3,
      'sync-balance': 4,
      'lock-point': 5,
      'wait-withdraw-point': 6, // aka getSecret
      'withdraw-btc': 7,
      'finish': 8,
      'end': 9
    }

    this.pointSwap = swap.participantSwap
    this.btcSwap = swap.ownerSwap

    if (!this.pointSwap) {
      throw new Error('BTC2POINT: "pointSwap" of type object required')
    }
    if (!this.btcSwap) {
      throw new Error('BTC2POINT: "btcSwap" of type object required')
    }

    this.state = {
      step: 0,

      signTransactionHash: null,
      isSignFetching: false,
      isMeSigned: false,

      secretHash: null,
      btcScriptValues: null,
      pointScriptValues: null,

      btcScriptVerified: false,

      isBalanceFetching: false,
      isBalanceEnough: false,
      balance: null,

      btcScriptCreatingTransactionHash: null,
      pointSwapCreationTransactionHash: null,

      isPointScriptFunded: false,

      secret: null,

      isPointWithdrawn: false,
      isBtcWithdrawn: false,

      refundTransactionHash: null,
      isRefunded: false,

      isFinished: false,
      isSwapExist: false,
    }

    super._persistSteps()
    this._persistState()
  }

  _persistState() {
    super._persistState()
  }

  _getSteps() {
    const flow = this

    return [

      // 1. Sign swap to start

      () => {
        // this.sign()
      },

      // 2. Wait participant create, fund BTC Script

      () => {
        flow.swap.room.once('create btc script', ({ scriptValues, btcScriptCreatingTransactionHash }) => {
          flow.finishStep({
            secretHash: scriptValues.secretHash,
            btcScriptValues: scriptValues,
            btcScriptCreatingTransactionHash,
          }, { step: 'wait-lock-btc', silentError: true })
        })

        flow.swap.room.sendMessage({
          event: 'request btc script',
        })
      },

      // 3. Verify BTC Script

      () => {
        debug('swap.core:flow')(`waiting verify btc script`)
        // this.verifyBtcScript()
      },

      // 4. Check balance

      () => {
        this.syncBalance()
        debug('swap.core:flow')(this)
      },

      // 5. Create POINT Script

      async () => {
        const { participant, buyAmount, sellAmount } = flow.swap
        let pointSwapCreationTransactionHash

        // TODO move this somewhere!
        const utcNow = () => Math.floor(Date.now() / 1000)
        const getLockTime = () => utcNow() + 3600 * 1 // 1 hour from now

        const scriptCheckResult = await flow.btcSwap.checkScript(flow.state.btcScriptValues, {
          value: buyAmount,
          recipientPublicKey: this.app.services.auth.accounts.btc.getPublicKey(),
          lockTime: getLockTime(),
        })

        if (scriptCheckResult) {
          console.error(`Btc script check error:`, scriptCheckResult)
          flow.swap.events.dispatch('btc script check error', scriptCheckResult)
          return
        }

        const scriptValues = {
          secretHash:         flow.state.secretHash,
          ownerPublicKey:     this.app.services.auth.accounts.point.getPublicKey(),
          recipientPublicKey: participant.point.publicKey,
          lockTime:           getLockTime(),
        }

        try {
          await flow.pointSwap.fundScript({
            scriptValues,
            amount: sellAmount,
          }, (hash) => {
            pointSwapCreationTransactionHash = hash
            flow.setState({
              pointSwapCreationTransactionHash: hash,
            })
          })
        } catch (err) {
          // TODO user can stuck here after page reload...
          if ( /known transaction/.test(err.message) )
            return console.error(`known tx: ${err.message}`)
          else if ( /out of gas/.test(err.message) )
            return console.error(`tx failed (wrong secret?): ${err.message}`)
          else
            return console.error(err)
        }

        flow.swap.room.on('request point script', () => {
          flow.swap.room.sendMessage({
            event: 'create point script',
            data: {
              scriptValues,
              pointSwapCreationTransactionHash,
            }
          })
        })

        flow.swap.room.sendMessage({
          event: 'create point script',
          data: {
            scriptValues,
            pointSwapCreationTransactionHash,
          }
        })

        flow.finishStep({
          isPointScriptFunded: true,
          pointScriptValues: scriptValues,
        }, { step: 'lock-point' })
      },

      // 6. Wait participant withdraw

      () => {

        flow.swap.room.once('pointWithdrawTxHash', async ({ pointSwapWithdrawTransactionHash }) => {
          flow.setState({
            pointSwapWithdrawTransactionHash,
          })

          const secret = await flow.pointSwap.getSecretFromTxhash(pointSwapWithdrawTransactionHash)

          if (!flow.state.isPointWithdrawn && secret) {
            flow.finishStep({
              isPointWithdrawn: true,
              secret,
            }, { step: 'wait-withdraw-point' })
          }
        })

        flow.swap.room.sendMessage({
          event: 'request pointWithdrawTxHash',
        })
      },

      // 7. Withdraw

      async () => {
        let { secret, btcScriptValues } = flow.state

        if (!btcScriptValues) {
          console.error('There is no "btcScriptValues" in state. No way to continue swap...')
          return
        }

        await flow.btcSwap.withdraw({
          scriptValues: flow.state.btcScriptValues,
          secret,
        }, (hash) => {
          flow.setState({
            btcSwapWithdrawTransactionHash: hash,
          })
        })

        flow.finishStep({
          isBtcWithdrawn: true,
        }, { step: 'withdraw-btc' })
      },

      // 8. Finish

      () => {
        flow.swap.room.sendMessage({
          event: 'swap finished',
        })

        flow.finishStep({
          isFinished: true,
        }, { step: 'finish' })
      },

      // 9. Finished!
      () => {

      }
    ]
  }

  _checkSwapAlreadyExists() {
    const { participant } = this.swap

    const swapData = {
      ownerAddress:       this.app.services.auth.accounts.point.address,
      participantAddress: participant.point.address
    }

    return false//this.pointSwap.checkSwapExists(swapData)
  }

  async sign() {
    const swapExists = await this._checkSwapAlreadyExists()

    if (swapExists) {
      this.swap.room.sendMessage({
        event: 'swap exists',
      })

      this.setState({
        isSwapExist: true,
      })
    } else {
      this.setState({
        isSignFetching: true,
      })

      this.swap.room.on('request sign', () => {
        this.swap.room.sendMessage({
          event: 'swap sign',
        })
      })

      this.swap.room.sendMessage({
        event: 'swap sign',
      })

      this.finishStep({
        isMeSigned: true,
      }, { step: 'sign', silentError: true })

      return true
    }
  }


  verifyBtcScript() {
    if (this.state.btcScriptVerified) {
      return true
    }
    if (!this.state.btcScriptValues) {
      throw new Error(`No script, cannot verify`)
    }

    this.finishStep({
      btcScriptVerified: true,
    }, { step: 'verify-script' })

    return true
  }

  async syncBalance() {
    const { sellAmount } = this.swap

    this.setState({
      isBalanceFetching: true,
    })

    const balance = await this.pointSwap.fetchBalance(this.app.services.auth.accounts.point.getAddress())

    const isEnoughMoney = sellAmount.isLessThanOrEqualTo(balance)

    if (isEnoughMoney) {
      this.finishStep({
        balance,
        isBalanceFetching: false,
        isBalanceEnough: true,
      }, { step: 'sync-balance' })
    }
    else {
      this.setState({
        balance,
        isBalanceFetching: false,
        isBalanceEnough: false,
      })
    }
  }

  getRefundTxHex = () => {
    this.pointSwap.getRefundHexTransaction({
      scriptValues: this.state.pointScriptValues,
      secret: this.state.secret,
    })
      .then((txHex) => {
        this.setState({
          refundTxHex: txHex,
        })
      })
  }

  tryRefund() {
    const { participant } = this.swap

    return this.pointSwap.refund({
      scriptValues: this.state.pointScriptValues,
      secret: this.state.secret,
    }, (hash) => {
      this.setState({
        refundTransactionHash: hash,
        isRefunded: true,
      })
    })
      .then(() => {
        this.swap.room.sendMessage({
          event: 'refund completed',
        })

        this.setState({
          isSwapExist: false,
        })
      })
  }

  async isRefundSuccess() {
    return true
  }

  async tryWithdraw(_secret) {
    const { secret, secretHash, isPointWithdrawn, isBtcWithdrawn, btcScriptValues } = this.state
    if (!_secret)
      throw new Error(`Withdrawal is automatic. For manual withdrawal, provide a secret`)

    if (!btcScriptValues)
      throw new Error(`Cannot withdraw without script values`)

    if (secret && secret != _secret)
      console.warn(`Secret already known and is different. Are you sure?`)

    if (isBtcWithdrawn)
      console.warn(`Looks like money were already withdrawn, are you sure?`)

    debug('swap.core:flow')(`WITHDRAW using secret = ${_secret}`)

    const _secretHash = crypto.ripemd160(Buffer.from(_secret, 'hex')).toString('hex')
    if (secretHash != _secretHash)
      console.warn(`Hash does not match!`)

    const { scriptAddress } = this.btcSwap.createScript(btcScriptValues)
    const balance = await this.btcSwap.getBalance(scriptAddress)

    debug('swap.core:flow')(`address=${scriptAddress}, balance=${balance}`)

    if (balance === 0) {
      this.finishStep({
        isBtcWithdrawn: true,
      }, { step: 'withdraw-btc' })
      throw new Error(`Already withdrawn: address=${scriptAddress},balance=${balance}`)
    }

    await this.btcSwap.withdraw({
      scriptValues: btcScriptValues,
      secret: _secret,
    }, (hash) => {
      debug('swap.core:flow')(`TX hash=${hash}`)
      this.setState({
        btcSwapWithdrawTransactionHash: hash,
      })
    })
    debug('swap.core:flow')(`TX withdraw sent: ${this.state.btcSwapWithdrawTransactionHash}`)

    this.finishStep({
      isBtcWithdrawn: true,
    }, { step: 'withdraw-btc' })
  }

}


export default POINT2BTC
