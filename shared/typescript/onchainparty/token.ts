/**
 * This token class is a wrapper around the web3.eth.Contract class.
 * 
 * - Liquid for Dexlens.io
 */

class Token {
    // TODO: Fix this any
    private web3: any;
    constructor(web3: any) {
        this.web3 = web3;
    }

    /**
     * 
     * @param contract_address - The address of the contract to get the balance of
     * @param account - The account to get the balance of
     * @returns The balance of the account
     */
    async balanceOf(contract_address: string, account: string) {
        let contract = new this.web3.eth.Contract([{
            "constant": true,
            "inputs": [{
                "internalType": "address",
                "name": "owner",
                "type": "address",
            }],
            "name": "balanceOf",
            "outputs": [{
                "internalType": "uint256",
                "name": "",
                "type": "uint256",
            }],
            "payable": false,
            "stateMutability": "view",
            "type": "function",
        }], contract_address);
        let balance = await contract.methods.balanceOf(account).call();
        return balance;
    }

    /**
     * 
     * @param contract_address - The address of the contract to get the owner of
     * @param tokenId - The token ID to get the owner of
     * @returns The owner of the token
     * @returns The owner of the token
     */
    async ownerOf(contract_address: string, tokenId: number) {
        let contract = new this.web3.eth.Contract([{
            "inputs": [{
                "internalType": "uint256",
                "name": "tokenId",
                "type": "uint256",
            }],
            "name": "ownerOf",
            "outputs": [{
                "internalType": "address",
                "name": "",
                "type": "address",
            }],
            "stateMutability": "view",
            "type": "function",
        }], contract_address);
        console.log("contract", contract);
        let owner = await contract.methods.ownerOf(tokenId).call();
        return owner;
    }

    /**
     * 
     * @param contract_address - The address of the contract to get the token URI of§
     * @param tokenId - The token ID to get the URI of
     * @returns The URI of the token
     */
    async tokenURI(contract_address: string, tokenId: number) {
        let contract = new this.web3.eth.Contract([{
            "inputs": [{
                "internalType": "uint256",
                "name": "tokenId",
                "type": "uint256",
            }],
            "name": "tokenURI",
            "outputs": [{
                "internalType": "string",
                "name": "",
                "type": "string",
            }],
            "stateMutability": "view",
            "type": "function",
        }], contract_address);
        let tokenURI = await contract.methods.tokenURI(tokenId).call();
        return tokenURI;
    }

    /**
     * 
     * @param contract_address - The address of the contract to get the owner of
     * @returns The owner of the contract
     */
    async owner(contract_address: string) {
        let contract = new this.web3.eth.Contract([{
            "inputs": [],
            "name": "owner",
            "outputs": [{
                "internalType": "address",
                "name": "",
                "type": "address",
            }],
            "stateMutability": "view",
            "type": "function",
        }], contract_address);
        let owner = await contract.methods.owner().call();
        return owner;
    }
}

export default Token;