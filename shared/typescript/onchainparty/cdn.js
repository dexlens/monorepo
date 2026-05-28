/**
/**
 * OnchainParty Frontend CDN Module
 * ================================
 *
 * This module is designed for frontend usage (vanilla JS) and can be included in browser environments.
 * It provides a simple JavaScript client to interact with OnchainParty authentication/session endpoints,
 * enabling web applications to connect to blockchain wallets, manage sessions, and interact with contracts
 * without extra frontend dependencies.
 *
 * Usage:
 *   - Load this file directly in your web app as a standard JS module.
 *   - Supports browser-based session management, authentication, and wallet connection logic.
 *
 * Note:
 *   - For backend/node.js usage, use the server-side version instead.
 *   - To use this you will need to build it for Browser usage.
 * 
 * Maintained by Liquid for Dexlens.io
 */

import Superprovider from "npm:superprovider";
import Web3 from "npm:web3";

class OnchainParty {
  constructor(o) {
    this.host = (o && o.host ? o.host : "")
    this.superprovider = new Superprovider(o)
  }
  async party(name) {
    if (!this.parties) {
      let r = await fetch(this.host + "/onchainparty", {
        credentials: (this.host === "" ? "same-origin" : "include"),
      }).then(r => r.json())
      this.parties = r.parties
      this.csrfToken = r.csrfToken
    }
    if (name) {
      return this.parties[name]
    } else {
      return this.parties
    }
  }
  async path(name, pathName) {
    let p = await this.party(name)
    return p[pathName]
  }
  // Get current session info
  async session(name) {
    let url = await this.path(name, "session")
    let r = await fetch(this.host + url, {
      credentials: (this.host === "" ? "same-origin" : "include"),
    }).then((r) => {
      return r.json()
    })
    return r[name]
  }
  async gate(name) {
    let url = await this.path(name, "gate")
    return url
  }
  async sign(str) {
    let result = await this.provider.request({
      method: "personal_sign",
      params: [ this.web3.utils.fromUtf8(str), this.account ]
    })
    return result
  }
  // Connect and session
  async connect(name, payload, options) {
    let provider = await this.superprovider.connect((options && options.fresh ? true : false))
    this.provider = provider
    this.account = this.superprovider.account
    this.web3 = new Web3(provider)
    const now = Date.now()
    let url = await this.path(name, "connect")
    const str = `authenticating ${this.account} at ${now} with nonce ${this.csrfToken}`
    let sig = await this.sign(str)
    let r = await fetch(this.host + url, {
      method: "POST",
      credentials: (this.host === "" ? "same-origin" : "include"),
      headers: {
        "Content-Type": "application/json",
        'CSRF-Token': this.csrfToken,
      },
      body: JSON.stringify({
        str,
        sig,
        payload
      })
    }).then((res) => {
      if(res.ok) {
        return res.json()
      } else {
        return res.json().then((json) => {
          throw new Error(json.error)
        })
      }
    })
    this.parties = null   // clear parties so it will refetch parties and csrfToken next time
    this.csrfToken = null
    if (this.walletconnect) {
      localStorage.removeItem("WALLETCONNECT_DEEPLINK_CHOICE")
    }
    return r
  }
  // Delete session
  async disconnect(name) {
    let url = await this.path(name, "disconnect")
    let r = await fetch(this.host + url, {
      method: "POST",
      credentials: (this.host === "" ? "same-origin" : "include"),
      headers: {
        "Content-Type": "application/json",
        'CSRF-Token': this.csrfToken,
      },
      body: JSON.stringify({ name })
    }).then((res) => {
      return res.json()
    })
    this.parties = null   // clear parties so it will refetch parties and csrfToken next time
    this.csrfToken = null
    await this.superprovider.disconnect()
    this.provider = null;
    this.account = null;
    this.web3 = null;
    return null
  }
}

export default OnchainParty
