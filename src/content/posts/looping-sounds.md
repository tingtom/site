---
title: Looping Sprint Sounds
slug: looping-sprint-sounds
date: 2017-05-06
mins: 5
summary: I have added two sprint loops to HL2 mods and both were done in slightly different ways, a sprint loop is a sound that plays over and over again while the player is sprinting and adds a "realistic" sound to go with the sprint key instead of something like the HL2 whoosh sound when you press the key.
sections: ["personal"]
---

I have added two sprint loops to HL2 mods and both were done in slightly different ways, a sprint loop is a sound that plays over and over again while the player is sprinting and adds a "realistic" sound to go with the sprint key instead of something like the HL2 whoosh sound when you press the key.

The first sprint loop has one sprint sound that loops normally while sprinting but is faded out and in which is all done in code, first we check if the player is sprinting by checking the boolean flag and making sure the player is actually moving by checking the velocity:

```cpp
bool running = (m_fIsSprinting && GetAbsVelocity().Length2D() > 40);
```

I coded the entire sprint block differently before but figured I can make it work and look better, the beginning of the block is an if statement to check if the player is running or if the start sprint time is larger than zero since the default is zero then the EmitSound structure is created and filled with the sound name and a flag:

```cpp
if( running || m_fSprintStart > 0.0f)
{
	EmitSound_t t;
	t.m_pSoundName = "Player.SprintLoop";
	t.m_nFlags = SND_CHANGE_VOL;
```

After this I do a check to see if the start sprint time is larger than zero again and if the player is not running which means the fade in was started and the player has just stopped running. This is when we do the fade out and final stopping of the loop/reset of the code:

```cpp
if( m_fSprintStart > 0.0f && !running )
{
	float diff = gpGlobals->curtime - m_fSprintEnd;
		
	//Fadeout under 1 seconds
	if( diff < 1.0f )
		t.m_flVolume = 1 - diff / 1.0f;
	else {
		m_fSprintStart = 0.0f;
		m_fSprintEnd = 0.0f;
		t.m_nFlags = SND_STOP;
	}
} else {
```

In the above code we calculate the different of the current time and the time when the sprinting finished, the fade out lasts for 1 second so I only fade out if the difference is below 1 second and then use that to reduce the volume of the sound which is enabled by the flag set earlier. if the difference is larger than 1 second both variables are reset and the flag is set to SND_STOP which will stop the emitting of the sound.

Next we do something similar to the fade out where we check the difference from the start sound and use that to fade in the volume:

```cpp
	float diff = gpGlobals->curtime - m_fSprintStart;
		
	//Fadein under 3 seconds
	if( diff < 3.0f )
		t.m_flVolume = diff / 3.0f;
}
```

After this we do a normal EmitSound and pass the "t" structure created earlier:

```cpp
CPASAttenuationFilter filter( this );
filter.UsePredictionRules();
EmitSound(filter, entindex(), t );
```

All of the sprint code has been put in the PostThink of the hl2_player.cpp file and I have two variables in the header file for the start time of the sprint and the end time of the sprint, click here for the full source code in a gist and here's the result in video form:

<iframe title="HL2 Modding - Looping sprint sounds" style="display: block; margin-left: auto; margin-right: auto;max-width:560px" src="https://www.youtube.com/embed/0RxOiKM2xqA?rel=0" allowfullscreen="allowfullscreen" width="100%" height="315" frameborder="0"></iframe>
