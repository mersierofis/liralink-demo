import { Buffer } from "buffer";
import { Client as ContractClient, Spec as ContractSpec, } from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";
if (typeof window !== "undefined") {
    //@ts-ignore Buffer exists
    window.Buffer = window.Buffer || Buffer;
}
export const networks = {
    testnet: {
        networkPassphrase: "Test SDF Network ; September 2015",
        contractId: "CDKZYQI4HI347ZVAMXT2XPHLYDSDKN6ERELKASGJDII6AQU6ROFQ45EJ",
    }
};
export const Errors = {
    1: { message: "AlreadyExists" },
    2: { message: "NotFound" },
    3: { message: "NotPending" },
    4: { message: "Expired" },
    5: { message: "InvalidAmount" }
};
export var Status;
(function (Status) {
    Status[Status["Pending"] = 0] = "Pending";
    Status[Status["Paid"] = 1] = "Paid";
    Status[Status["Cancelled"] = 2] = "Cancelled";
})(Status || (Status = {}));
export class Client extends ContractClient {
    options;
    static async deploy(
    /** Constructor/Initialization Args for the contract's `__constructor` method */
    { token, admin }, 
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options) {
        return ContractClient.deploy({ token, admin }, options);
    }
    constructor(options) {
        super(new ContractSpec(["AAAABQAAAAAAAAAAAAAABFBhaWQAAAABAAAABHBhaWQAAAAEAAAAAAAAAARjb2RlAAAAEQAAAAEAAAAAAAAABXBheWVyAAAAAAAAEwAAAAAAAAAAAAAACG1lcmNoYW50AAAAEwAAAAAAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAC",
            "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAABQAAAAAAAAANQWxyZWFkeUV4aXN0cwAAAAAAAAEAAAAAAAAACE5vdEZvdW5kAAAAAgAAAAAAAAAKTm90UGVuZGluZwAAAAAAAwAAAAAAAAAHRXhwaXJlZAAAAAAEAAAAAAAAAA1JbnZhbGlkQW1vdW50AAAAAAAABQ==",
            "AAAAAwAAAAAAAAAAAAAABlN0YXR1cwAAAAAAAwAAAAAAAAAHUGVuZGluZwAAAAAAAAAAAAAAAARQYWlkAAAAAQAAAAAAAAAJQ2FuY2VsbGVkAAAAAAAAAg==",
            "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAAAwAAAAAAAAAAAAAABVRva2VuAAAAAAAAAAAAAAAAAAAFQWRtaW4AAAAAAAABAAAAAAAAAAdJbnZvaWNlAAAAAAEAAAAR",
            "AAAAAQAAAAAAAAAAAAAAB0ludm9pY2UAAAAABgAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAARjb2RlAAAAEQAAAAAAAAAIZGVhZGxpbmUAAAAEAAAAAAAAAAhtZXJjaGFudAAAABMAAAAAAAAABXBheWVyAAAAAAAD6AAAABMAAAAAAAAABnN0YXR1cwAAAAAH0AAAAAZTdGF0dXMAAA==",
            "AAAABQAAAAAAAAAAAAAAB0NyZWF0ZWQAAAAAAQAAAAdjcmVhdGVkAAAAAAQAAAAAAAAABGNvZGUAAAARAAAAAQAAAAAAAAAIbWVyY2hhbnQAAAATAAAAAAAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAAAAAAIZGVhZGxpbmUAAAAEAAAAAAAAAAI=",
            "AAAABQAAAAAAAAAAAAAACUNhbmNlbGxlZAAAAAAAAAEAAAAJY2FuY2VsbGVkAAAAAAAAAgAAAAAAAAAEY29kZQAAABEAAAABAAAAAAAAAAhtZXJjaGFudAAAABMAAAAAAAAAAg==",
            "AAAAAAAAAD9SZWFkIGFuIGludm9pY2UuIFBhbmljcyB3aXRoIGBOb3RGb3VuZGAgaWYgdGhlIGNvZGUgaXMgdW5rbm93bi4AAAAAA2dldAAAAAABAAAAAAAAAARjb2RlAAAAEQAAAAEAAAfQAAAAB0ludm9pY2UA",
            "AAAAAAAAAJNQYXllciBzZXR0bGVzIGEgcGVuZGluZywgdW5leHBpcmVkIGludm9pY2U6IHRyYW5zZmVycyBgYW1vdW50YCBvZiB0aGUgcGlubmVkCnRva2VuIHBheWVyIC0+IG1lcmNoYW50IChhdXRob3JpemVkIGJ5IHRoZSBwYXllciksIHRoZW4gbWFya3MgaXQgUGFpZC4AAAAAA3BheQAAAAACAAAAAAAAAARjb2RlAAAAEQAAAAAAAAAFcGF5ZXIAAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
            "AAAAAAAAACZBZG1pbiBjYW5jZWxzIGEgc3RpbGwtcGVuZGluZyBpbnZvaWNlLgAAAAAABmNhbmNlbAAAAAAAAQAAAAAAAAAEY29kZQAAABEAAAABAAAD6QAAAAIAAAAD",
            "AAAAAAAAAGBBZG1pbiByZWNvcmRzIGFuIGludm9pY2UgcGF5YWJsZSB0byBgbWVyY2hhbnRgLiBGYWlscyBpZiBgY29kZWAgYWxyZWFkeSBleGlzdHMgb3IKYGFtb3VudCA8PSAwYC4AAAAGY3JlYXRlAAAAAAAEAAAAAAAAAAhtZXJjaGFudAAAABMAAAAAAAAABGNvZGUAAAARAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAACGRlYWRsaW5lAAAABAAAAAEAAAPpAAAAAgAAAAM=",
            "AAAAAAAAAJtEZXBsb3ktdGltZTogcGluIHRoZSB0b2tlbiAoVVNEQyBTdGVsbGFyIEFzc2V0IENvbnRyYWN0IGFkZHJlc3MpIHRoYXQgYHBheWAgdHJhbnNmZXJzCmFuZCB0aGUgYWRtaW4gKHBsYXRmb3JtIGFjY291bnQpIHRoYXQgbWF5IGNyZWF0ZSBhbmQgY2FuY2VsIGludm9pY2VzLgAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAIAAAAAAAAABXRva2VuAAAAAAAAEwAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAA=="]), options);
        this.options = options;
    }
    fromJSON = {
        get: (this.txFromJSON),
        pay: (this.txFromJSON),
        cancel: (this.txFromJSON),
        create: (this.txFromJSON)
    };
}
