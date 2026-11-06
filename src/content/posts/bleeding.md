---
title: Player bleeding in Source SDK
slug: bleeding-in-source
date: 2019-11-05
mins: 12
summary: A random feature I added to a HL2MP mod was for the player to bleed for a bit after being shot, it uses HL2 particles to bleed from bullet holes for a specified amount of time.
sections: ["personal"]
---

A random feature I added to a HL2MP mod was for the player to bleed for a bit after being shot, it uses HL2 particles to bleed from bullet holes for a specified amount of time. Here's how I did it:

First we set up some variables in hl2mp_player.h
```cpp
CNetworkVar( bool, m_bBleeding );
Vector bleedPos;
Vector bleedDir;
float m_flBleedingTime;
int bleedingAmount;
```

and then set the defaults for bleeding in hl2mp_player.cpp (Spawn function)

```cpp
m_bBleeding = false;
m_flBleedingTime = 0.0f;
bleedingAmount = 0;
```

Still in hl2mp_player but in PostThink we do the actual bleeding based on these variables:

```cpp
if( m_bBleeding && bleedingAmount > 0 && m_flBleedingTime < gpGlobals->curtime )
{
    //Bleed a little bit
    TakeHealth( -1, DMG_GENERIC );

    //Decrement
    bleedingAmount--;
    m_flBleedingTime = gpGlobals->curtime + BLEED_TIME;

    //Finished bleeding
    if( !bleedingAmount )
        m_bBleeding = false;

    //Spawn blood
    UTIL_BloodSpray( bleedPos * GetAbsOrigin(), bleedDir, BloodColor(), bleedingAmount, FX_BLOODSPRAY_ALL );
    UTIL_BloodDrips( bleedPos, bleedDir, BloodColor(), bleedingAmount );
}
```

Now to actually start bleeding when damage is taken, so in OnTakeDamage we do this:

```cpp
if( inputInfo.GetMaxDamage() != -1.0f )
{
    //Bleed!
    m_bBleeding = true;
    m_flBleedingTime = gpGlobals->curtime;
    bleedingAmount = (int)ceil((float)inputInfo.GetDamage() / 5.0f);

    Vector vecDir = vec3_origin;
    if( inputInfo.GetInflictor() )
    {
        vecDir = inputInfo.GetInflictor()->WorldSpaceCenter() - Vector ( 0, 0, 10 ) - WorldSpaceCenter();
        VectorNormalize( vecDir );
    }

    //Store last took damage
    bleedPos = inputInfo.GetDamagePosition() / GetAbsOrigin();
    bleedDir = vecDir;
}
```

Here if the player is damaged we store the direction of the shot and calculate the position based on the offset on the players position. Now we need to network it so the player can see the blood on their end so we pop this in the send table as always:

```cpp
SendPropBool( SENDINFO( m_bBleeding ) )
```

and add this to the recieve table in c_hl2mp_player.cpp:

```cpp
RecvPropBool( RECVINFO( m_bBleeding ) )
```

and add two new variables to c_hl2mp_player.h:

```cpp
//Bleeding
bool m_bBleeding;
float m_flTrailTime;
```

and set the defaults in Spawn (back in the cpp file) to this:

```cpp
//Bleeding
m_bBleeding = false;
m_flTrailTime = 0.0f;
```

and now in ClientThink we do the bleeding for the local player!

```cpp
//Bleed!
if( m_bBleeding && m_flTrailTime < gpGlobals->curtime && GetGroundEntity() )
{
    //Do a traceline from the player downwards
    trace_t tr;
    UTIL_TraceLine( GetAbsOrigin(), GetAbsOrigin()*Vector(0,0,-10), MASK_SOLID, this, COLLISION_GROUP_NONE, &tr );

    //Draw blood decal and increase time
    UTIL_BloodDecalTrace( &tr, BLOOD_COLOR_RED );
    m_flTrailTime = gpGlobals->curtime+0.5f;
}
```
