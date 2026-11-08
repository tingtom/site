---
title: Physgun Weapon
slug: physgun-weapon
date: 2017-08-16
mins: 5
summary: Back when I worked on Zombie Survival I got bored one day and seeked out how to implement and use the Physgun that everyone saw in the HL2 beta trailer, this code was leaked back when HL2 was coming out and never ended up in the final game.
sections: ["personal"]
---

Back when I worked on Zombie Survival I got bored one day and seeked out how to implement and use the Physgun that everyone saw in the HL2 beta trailer, this code was leaked back when HL2 was coming out and never ended up in the final game.

Recently someone asked about it so I decided to make this post and release the code I gathered on it, this version works very well and has a new feature which allows you to freeze and unfreeze objects. While testing the code I also found out a way to get the original beam code working so this also includes that, back when I first worked on it the beam was replaced with a serverside straight beam to the object.

The source code is available [here]("https://gist.github.com/tingtom/47ef360d3183b41676e2552c8193bb1f"), there's no need to edit the c_weapon__stubs_hl2 file like other weapons since the weapon declares itself you just need add the physgun.cpp file to the server project and the c_weapon_gravitygun.cpp file to the client project.

Video of the weapon:

<iframe title="HL2 Modding - Physgun" style="display: block; margin-left: auto; margin-right: auto;max-width:560px" src="//www.youtube.com/embed/OEVRGoE1T7o?rel=0" allowfullscreen="allowfullscreen" width="100%" height="315" frameborder="0"></iframe>
