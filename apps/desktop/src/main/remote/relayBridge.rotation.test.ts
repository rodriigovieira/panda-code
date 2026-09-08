import { expect, it, vi } from "vitest";
import {createRelayBridge} from "./relayBridge";
it("revokes only the selected phone through its independent relay identity",async()=>{
 const bridge=createRelayBridge({url:"https://relay.test"} as Parameters<typeof createRelayBridge>[0]);
 const mutation=vi.fn(async()=>[{mobileId:"other",createdAt:1,notificationsEnabled:true}]);
 const state=bridge as unknown as {credentials:unknown;client:unknown};
 const credentials={deviceId:"device",token:"fixture",key:new Uint8Array(32)};
 state.credentials=credentials;
 state.client={mutation};
 await expect(bridge.revokePairedDevice("phone")).resolves.toEqual([{mobileId:"other",createdAt:1,notificationsEnabled:true}]);
 expect(mutation).toHaveBeenCalledWith(expect.anything(),{deviceId:"device",token:"fixture",mobileId:"phone"});
});
