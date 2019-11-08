import debug from 'debug'
import crypto from 'bitcoinjs-lib/src/crypto'
import SwapApp, { constants } from 'swap.app'
import { Flow } from 'swap.swap'


class BTC2POINT extends Flow {

  static getName() {
    return `${this.getFromName()}2${this.getToName()}`
  }
  static getFromName() {
    return constants.COINS.btc
  }
  static getToName() {
    return constants.COINS.point
  }

  constructor(swap) {
    super(swap)

    this._flowName = BTC2POINT.getName()

    this.stepNumbers = {
      'sign': 1,
      'submit-secret': 2,
      'sync-balance': 3,
      'lock-btc': 4,
      'wait-lock-point': 5,
      'withdraw-point': 6,
      'finish': 7,
      'end': 8
    }

    this.pointSwap = swap.ownerSwap
    this.btcSwap = swap.participantSwap

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
      isParticipantSigned: false,

      btcScriptCreatingTransactionHash: null,
      pointSwapCreationTransactionHash: null,

      secretHash: null,
      btcScriptValues: null,

      btcScriptVerified: false,

      pointScriptValues: null,

      isBalanceFetching: false,
      isBalanceEnough: false,
      balance: null,

      isPointScriptFunded: false,

      pointSwapWithdrawTransactionHash: null,
      isPointWithdrawn: false,

      refundTransactionHash: null,
      isRefunded: false,

      refundTxHex: null,
      isFinished: false,
      isSwapExist: false,
    }

    super._persistSteps()
    this._persistState()
  }

  _persistState() {
    super._persistState()

    // this.pointSwap.getBalance({
    //   ownerAddress: this.swap.participant.point.address,
    // })
    //   .then((balance) => {
    //     debug('swap.core:flow')('balance:', balance)
    //   })
  }

  _getSteps() {
    const flow = this

    return [

      // 1. Signs

      () => {
        flow.swap.room.once('swap sign', () => {
          flow.finishStep({
            isParticipantSigned: true,
          }, { step: 'sign', silentError: true })
        })

        flow.swap.room.once('swap exists', () => {
          flow.setState({
            isSwapExist: true,
          })
        })

        if (flow.state.isSwapExist) {
          flow.swap.room.once('refund completed', () => {
            flow.swap.room.sendMessage({
              event: 'request sign',
            })
          })
        } else {
          flow.swap.room.sendMessage({
            event: 'request sign',
          })
        }
      },
      // 2. Create secret, secret hash

      () => {
        // this.submitSecret()
      },

      // 3. Check balance

      () => {
        this.syncBalance()
      },

      // 4. Create BTC Script, fund, notify participant

      async () => {
        const { sellAmount, participant } = flow.swap
        let btcScriptCreatingTransactionHash

        // TODO move this somewhere!
        const utcNow = () => Math.floor(Date.now() / 1000)
        const getLockTime = () => utcNow() + 3600 * 3 // 3 hours from now

        const scriptValues = {
          secretHash:         flow.state.secretHash,
          ownerPublicKey:     this.app.services.auth.accounts.btc.getPublicKey(),
          recipientPublicKey: participant.btc.publicKey,
          lockTime:           getLockTime(),
        }

        await flow.btcSwap.fundScript({
          scriptValues,
          amount: sellAmount,
        }, (hash) => {
          btcScriptCreatingTransactionHash = hash
          flow.setState({
            btcScriptCreatingTransactionHash: hash,
          })
        })

        flow.swap.room.on('request btc script', () => {
          flow.swap.room.sendMessage({
            event: 'create btc script',
            data: {
              scriptValues,
              btcScriptCreatingTransactionHash,
            }
          })
        })

        flow.swap.room.sendMessage({
          event: 'create btc script',
          data: {
            scriptValues,
            btcScriptCreatingTransactionHash,
          }
        })

        flow.finishStep({
          isBtcScriptFunded: true,
          btcScriptValues: scriptValues,
        }, {  step: 'lock-btc' })
      },

      // 5. Wait participant creates POINT Script

      () => {
        const { participant } = flow.swap
        let timer

        flow.swap.room.once('create point script', ({scriptValues, pointSwapCreationTransactionHash }) => {
          flow.setState({
            secretHash: scriptValues.secretHash,
            pointScriptValues: scriptValues,
            pointSwapCreationTransactionHash,
          })
        })

        flow.swap.room.sendMessage({
          event: 'request point script',
        })

        const checkPointBalance = () => {
          timer = setTimeout(async () => {
            const { scriptAddress } = this.pointSwap.createScript(flow.state.pointScriptValues)
            const balance = await flow.pointSwap.getBalance(scriptAddress)

            debug('swap.core:flow')('Point balance - ' + balance)

            if (balance > 0) {
              if (!flow.state.isPointScriptFunded) { // redundant condition but who cares :D
                flow.finishStep({
                  isPointScriptFunded: true,
                }, { step: 'wait-lock-point' })
              }
            }
            else {
              checkPointBalance()
            }
          }, 20 * 1000)
        }

        checkPointBalance()

        flow.swap.room.once('create point script', () => {
          if (!flow.state.isPointScriptFunded) {
            clearTimeout(timer)
            timer = null

            flow.finishStep({
              isPointScriptFunded: true,
            }, { step: 'wait-lock-point' })
          }
        })
      },

      // 6. Withdraw

      async () => {
        const { buyAmount, participant } = flow.swap
        let { secret, pointScriptValues } = flow.state

        const data = {
          ownerAddress:   participant.point.address,
          secret:         flow.state.secret,
        }

        const balanceCheckResult = await flow.pointSwap.checkBalance({
          ownerAddress: participant.point.address,
          expectedValue: buyAmount,
        })

        if (balanceCheckResult) {
          console.error(`Waiting until deposit: POINT balance check error:`, balanceCheckResult)
          flow.swap.events.dispatch('point balance check error', balanceCheckResult)
          return
        }

        try {
          await flow.pointSwap.withdraw({
            scriptValues: pointScriptValues,
            secret,
          }, (hash) => {
            flow.setState({
              pointSwapWithdrawTransactionHash: hash,
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

        flow.swap.room.on('request pointWithdrawTxHash', () => {
          flow.swap.room.sendMessage({
            event: 'pointWithdrawTxHash',
            data: {
              scriptValues: flow.state.pointScriptValues,
              pointSwapWithdrawTransactionHash: flow.state.pointSwapWithdrawTransactionHash,
            },
          })
        })

        flow.swap.room.sendMessage({
          event: 'finish point withdraw',
        })

        flow.finishStep({
          isPointWithdrawn: true,
        })
      },

      // 7. Finish

      () => {
        flow.swap.room.once('swap finished', () => {
          flow.finishStep({
            isFinished: true,
          })
        })
      },

      // 8. Finished!
      () => {

      }
    ]
  }

  submitSecret(secret) {
    if (this.state.secret) { return }

    if (!this.state.isParticipantSigned) {
      throw new Error(`Cannot proceed: participant not signed. step=${this.state.step}`)
    }

    const secretHash = crypto.ripemd160(Buffer.from(secret, 'hex')).toString('hex')

    this.finishStep({
      secret,
      secretHash,
    }, { step: 'submit-secret' })
  }

  async syncBalance() {
    const { sellAmount } = this.swap

    this.setState({
      isBalanceFetching: true,
    })

    const balance = await this.btcSwap.fetchBalance(this.app.services.auth.accounts.btc.getAddress())
    const isEnoughMoney = sellAmount.isLessThanOrEqualTo(balance)

    if (isEnoughMoney) {
      this.finishStep({
        balance,
        isBalanceFetching: false,
        isBalanceEnough: true,
      }, { step: 'sync-balance' })
    }
    else {
      console.error(`Not enough money: ${balance} < ${sellAmount}`)
      this.setState({
        balance,
        isBalanceFetching: false,
        isBalanceEnough: false,
      })
    }
  }

  getRefundTxHex = () => {
    this.btcSwap.getRefundHexTransaction({
      scriptValues: this.state.btcScriptValues,
      secret: this.state.secret,
    })
      .then((txHex) => {
        this.setState({
          refundTxHex: txHex,
        })
      })
  }

  async isRefundSuccess() {
    const { refundTransactionHash, isRefunded } = this.state
    if (refundTransactionHash && isRefunded) {
      if (await this.btcSwap.checkTX(refundTransactionHash)) {
        return true
      } else {
        console.warn('BTC2POINT - unknown refund transaction')
        this.setState( {
          refundTransactionHash: null,
          isRefunded: false,
        } )
        return false
      }
    }
    return false
  }

  tryRefund() {
    return this.btcSwap.refund({
      scriptValues: this.state.btcScriptValues,
      secret: this.state.secret,
    }, (hash) => {
      this.setState({
        refundTransactionHash: hash,
        isRefunded: true,
      })
    })
      .then(() => {
        this.setState({
          isSwapExist: false,
        })
      })
  }
}


export default BTC2POINT
