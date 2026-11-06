---
title: ambient_generic OnEnd event
slug: ambient-generic-onend-event
date: 2018-01-16
mins: 20
summary: A quick snippet of code for the ambient_generic entity that will fire an output event when the sound has finished.
sections: ["personal"]
---

A quick snippet of code for the ambient_generic entity that will fire an output event when the sound has finished, useful for playing sounds one after another or whatever else you can come up with!

First you need two variables, one for tracking the end of the sound and another for the output event itself. Oh and a definition for a new think context for tracking the end, these all need to go in the CAmbientGeneric constructor in the public section:

```cpp
void EndThink();

float endTime;
COutputEvent m_OnEnd;
```

These then need going in the BEGIN_DATADESC section:

```cpp
DEFINE_OUTPUT(m_OnEnd, "OnEnd"),
DEFINE_FIELD( endTime, FIELD_FLOAT),
DEFINE_FUNCTION( EndThink ),
```

The endTime variable needs a default value so it can be setup to track the end of the sound, I usually set this to a value like -1. This goes in the Spawn function of the CAmbientGeneric class aswell as some code to setup the think function for tracking the end of the sound.

```cpp
endTime = -1.0f;

RegisterThinkContext("EndContext");
SetContextThink(&CAmbientGeneric::EndThink, gpGlobals->curtime, "EndContext");
SetNextThink(TICK_NEVER_THINK, "EndContext");
```

This code sets up a new think context so it can be controlled independently from the other think function called RampThink, this think doesn't start straight away and is only started in the Activate and ToggleSound functions of the CAmbientGeneric class:

```cpp
SetNextThink(gpGlobals->curtime + 0.1f, "EndContext");
```

The end of the ToggleSound function should look like this:

```cpp
InitModulationParms();

SendSound( SND_NOFLAGS ); // send sound

SetNextThink( gpGlobals->curtime + 0.1f );
SetNextThink(gpGlobals->curtime + 0.1f, "EndContext");
```

The only missing part now is the EndThink function:

```cpp
void CAmbientGeneric::EndThink()
{
	//Get duration of the file
	if (endTime == -1.0f)
		endTime = gpGlobals->curtime + enginesound->GetSoundDuration((char *)STRING(m_iszSound));
	else
		//Became inactive
		if (!m_fActive || gpGlobals->curtime > endTime)
		{
			m_OnEnd.FireOutput(this, this);
			endTime = -1.0f;
			return;
		}
	

	SetNextThink(gpGlobals->curtime + 1.0f, "EndContext");
}
```

This first checks the endTime variable to see if it's set or not and sets it to the duration of the current sound if it's not, if it is set a check is made to see if the sound was stopped on purpose or if the duration of the sound has elapsed. The endTime variable is then reset and the think function returns which means SetNextThink isn't called again so the EndThink code won't run until the sound is played again.
