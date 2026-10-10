// OrderFilled(bytes32,address,address,uint8,uint256,uint256,uint256,uint256,bytes32,bytes32)
// Indexed: orderHash, maker, taker. Edit this file when an exchange address or the event changes.

export const ORDER_FILLED_TOPIC = "0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee"

export const EXCHANGES = [
   "0xe111180000d2663c0091e4f400237545b87b996b",
   "0xe2222d279d744050d28e00520010520000310f59",
   "0xe3333700ca9d93003f00f0f71f8515005f6c00aa",
]

export const POLYGON_CHAIN_ID = 137n
