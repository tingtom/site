---
title: Enabling brush ladders
slug: enabling-brush-ladders
date: 2018-07-10
mins: 7
summary: A request while working on Resurgence was to add brush ladders which are a simpler implementation that don't use dismount points but instead fling you off the ladder at the top or bottom.
sections: ["personal"]
---

A request while working on Resurgence was to add brush ladders which are a simpler implementation that don't use dismount points but instead fling you off the ladder at the top or bottom, they are way easier to create in Hammer and easier to use as a player.

I found out how to do it when searching about the brush ladder and found [Valve's Developer Wiki](https://developer.valvesoftware.com/wiki/Co-Operative_Base_(Mod)) that listed it had managed to enable brush ladders, I checked out the source code for the enabling the brush ladder and it basically just disables the HL2 gamemovement that uses the gamemovement.cpp file as it's base and has some extra ladder code for handling dismounts. You can check out the file [on GitHub](https://github.com/whoozzem/SecobMod/blob/master/mp/src/game/shared/hl2/hl_gamemovement.cpp)

After that any brushes with func_ladder or textures with the climbable flag can be used as ladders, I would recommend changing the climb speed in shareddefs.h (103) and altering the velocity that the player gets pushed away from the ladder at which by default is [270](https://github.com/ValveSoftware/source-sdk-2013/blob/master/sp/src/game/shared/gamemovement.cpp#L2939).

It was way easier than I expected as whenever I went to tackle the issue I would look in func_ladder or gamemovement.cpp and didn't think about checking out the HL2 specific movement rules..

Code is available on my Github as always, just replace your file with the file in [this GitHub gist](https://gist.github.com/tingtom/5a3a92e7146eea8b74873a78edcb8dca)

