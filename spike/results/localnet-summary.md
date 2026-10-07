| Step | Result | Sent as | Compute units | Program instruction | Token-2022 inside it | Bytes as v0 (limit 1232) | Bytes as v1 (limit 4096) |
|---|---|---|---|---|---|---|---|
| setup: mint with ConfidentialTransferMint | pass | v0 | 2998 |  |  | 503 | 484 |
| setup: depositor confidential account | pass | v0 | 28570 |  |  | 670 | 652 |
| setup: recipient confidential account | pass | v0 | 27070 |  |  | 670 | 652 |
| setup: mint 1000, deposit 800 to the depositor's confidential balance | pass | v0 | 11663 |  |  | 400 | 380 |
| setup: depositor applies the pending balance | pass | v0 | 8172 |  |  | 387 | 366 |
| escrow 1: create the PDA's token account (top level) | pass | v0 | 18605 |  |  | 378 | 357 |
| 2.1 Reallocate by CPI | pass | v0 | 11860 | 11710 | 4904 | 377 | 356 |
| escrow 1: pubkey validity proof into a context account | pass | v0 | 2900 |  |  | 527 | 507 |
| 2.2 ConfigureAccount by CPI, proof in a context account | pass | v0 | 9083 | 8933 | 2113 | 453 | 432 |
| escrow 1: depositor funds 100 by confidential transfer (top level) | pass | v1 | 247853 |  |  | 3009 (over) | 2993 |
| 2.3 ApplyPendingBalance by CPI | pass | v0 | 14217 | 14067 | 8022 | 386 | 365 |
| 2.4 DisableConfidentialCredits by CPI | pass | v0 | 7255 | 7105 | 1060 | 342 | 321 |
| 2.4b a confidential transfer into the locked escrow is refused | fail, as expected | v1, simulated | 235125 |  |  | 3009 (over) | 2993 |
| escrow 1, transfer of 60: equality proof into a context account | pass | v0 | 6700 |  |  | 752 | 731 |
| escrow 1, transfer of 60: validity proof into a context account | pass | v0 | 16700 |  |  | 976 | 955 |
| escrow 1, transfer of 60: range proof into a context account | pass | v1 | 200150 |  |  | 1432 (over) | 1411 |
| 2.5 confidential Transfer by CPI, proofs in context accounts | pass | v0 | 22884 | 22734 | 14709 | 675 | 653 |
| 2.6 CloseContextState by CPI, three accounts, PDA is their authority | pass | v0 | 20512 | 20362 |  | 426 | 405 |
| 2.7x inline proofs, offsets pointing at the wrong proofs (simulated) | fail, as expected | v1, simulated | 232200 | 9400 | 2479 | 2520 (over) | 2498 |
| 2.7y inline proofs, a filler instruction not counted in the offsets (simulated) | fail, as expected | v1, simulated | 236657 | 9401 | 2479 | 2626 (over) | 2605 |
| 2.7a confidential Transfer by CPI, proofs inline before it, offsets -3 -2 -1 | pass | v1 | 245378 | 22578 | 15357 | 2520 (over) | 2498 |
| 2.7b confidential Transfer as the third CPI, proofs inline after it, offsets +1 +2 +3 | pass | v1 | 262659 | 39859 | 15363 | 2610 (over) | 2588 |
| 2.8x CloseAccount by CPI before EmptyAccount is refused (simulated) | fail, as expected | v0, simulated | 7854 | 7854 | 1680 | 342 | 321 |
| escrow 1: zero ciphertext proof into a context account | pass | v0 | 6300 |  |  | 624 | 603 |
| 2.8 EmptyAccount by CPI, proof in a context account | pass | v0 | 8121 | 7971 | 1542 | 376 | 355 |
| 2.9 CloseAccount by CPI | pass | v0 | 8480 | 8330 | 1938 | 342 | 321 |
| 2.10 CloseContextState by CPI, the two remaining accounts | pass | v0 | 15186 | 15036 |  | 384 | 363 |
| escrow 2: pubkey validity proof into a context account | pass | v0 | 2900 |  |  | 527 | 507 |
| 3.1 Create, one instruction, 4 CPIs: create account, Reallocate, ConfigureAccount (context proof), DisableNonConfidentialCredits | pass | v0 | 37206 | 37056 | 4904 + 2113 + 1060 | 553 | 532 |
| 3.2 Create, same 4 CPIs, pubkey validity proof inline as the next instruction (offset +1) | pass | v0 | 40160 | 37410 | 4904 + 2463 + 1060 | 685 | 665 |
| 3.2x a public TransferChecked into an escrow that refuses public credits (simulated) | fail, as expected | v0, simulated | 2691 |  |  | 417 | 396 |
| escrow 2: depositor funds 100 by confidential transfer (top level) | pass | v1 | 247853 |  |  | 3009 (over) | 2993 |
| escrow 3: depositor funds 100 by confidential transfer (top level) | pass | v1 | 247853 |  |  | 3009 (over) | 2993 |
| 3.3 Lock, one instruction, 2 CPIs: ApplyPendingBalance, DisableConfidentialCredits | pass | v0 | 15482 | 15332 | 8022 + 1060 | 396 | 375 |
| escrow 3: Lock | pass | v0 | 15482 | 15332 | 8022 + 1060 | 396 | 375 |
| escrow 2, settle: equality proof into a context account | pass | v0 | 6700 |  |  | 752 | 731 |
| escrow 2, settle: validity proof into a context account | pass | v0 | 16700 |  |  | 976 | 955 |
| escrow 2, settle: range proof into a context account | pass | v1 | 200150 |  |  | 1432 (over) | 1411 |
| escrow 2, settle: zero ciphertext proof for the balance after the transfer | pass | v0 | 6300 |  |  | 624 | 603 |
| 3.4 Settle, one instruction, 3 CPIs: Transfer (context proofs), EmptyAccount (context proof), CloseAccount | pass | v0 | 28980 | 28830 | 14709 + 1542 + 1938 | 729 | 707 |
| 3.4b after Settle: CloseContextState by CPI, the five context accounts of escrow 2 | pass | v0 | 29660 | 29510 |  | 510 | 489 |
| escrow 3, settle: equality proof into a context account | pass | v0 | 6700 |  |  | 752 | 731 |
| escrow 3, settle: validity proof into a context account | pass | v0 | 16700 |  |  | 976 | 955 |
| escrow 3, settle: range proof, create the context account | pass | v0 | 300 |  |  | 361 | 340 |
| escrow 3, settle: range proof, verify into the existing context account | pass | v1 | 200000 |  |  | 1279 (over) | 1257 |
| escrow 3, settle: zero ciphertext proof for the balance after the transfer | pass | v0 | 6300 |  |  | 624 | 603 |
| 3.5 Settle, one instruction, 7 CPIs: Transfer, EmptyAccount, CloseAccount and CloseContextState for the four proof accounts | pass | v0 | 49603 | 49453 | 14709 + 1542 + 1938 | 801 | 779 |
| escrow 4: Create with the proof inline | pass | v0 | 41660 | 38910 | 4904 + 2463 + 1060 | 685 | 665 |
| escrow 4: depositor funds 100 by confidential transfer (top level) | pass | v1 | 247853 |  |  | 3009 (over) | 2993 |
| escrow 4: Lock | pass | v0 | 15482 | 15332 | 8022 + 1060 | 396 | 375 |
| escrow 5: Create with the proof inline | pass | v0 | 44660 | 41910 | 4904 + 2463 + 1060 | 685 | 665 |
| escrow 5: depositor funds 100 by confidential transfer (top level) | pass | v1 | 247853 |  |  | 3009 (over) | 2993 |
| escrow 5: Lock | pass | v0 | 16982 | 16832 | 8022 + 1060 | 396 | 375 |
| escrow 4, settle: equality proof into a context account | pass | v0 | 6700 |  |  | 752 | 731 |
| escrow 4, settle: validity proof into a context account | pass | v0 | 16700 |  |  | 976 | 955 |
| escrow 4, settle: range proof into a context account | pass | v1 | 200150 |  |  | 1432 (over) | 1411 |
| escrow 4, settle: zero ciphertext proof for the balance after the transfer | pass | v0 | 6300 |  |  | 624 | 603 |
| escrow 5, settle: equality proof into a context account | pass | v0 | 6700 |  |  | 752 | 731 |
| escrow 5, settle: validity proof into a context account | pass | v0 | 16700 |  |  | 976 | 955 |
| escrow 5, settle: range proof into a context account | pass | v1 | 200150 |  |  | 1432 (over) | 1411 |
| escrow 5, settle: zero ciphertext proof for the balance after the transfer | pass | v0 | 6300 |  |  | 624 | 603 |
| 3.6x two escrows, each Transfer, EmptyAccount, CloseAccount, without closing the proof accounts (simulated) | pass | v0, simulated | 59310 | 59160 | 14709 + 1542 + 1938 + 14709 + 1542 + 1938 | 1186 | 1164 |
| 3.6 two escrows, each Transfer, EmptyAccount, CloseAccount and four CloseContextState: 14 CPIs in one transaction | pass | v1 | 100406 | 100406 | 14709 + 1542 + 1938 + 14709 + 1542 + 1938 | 1298 (over) | 1276 |
| recipient applies the pending balance | pass | v0 | 8172 |  |  | 387 | 366 |
