---
title: World Hints
slug: world-hints
date: 2017-07-26
mins: 17
summary: World hints are snippets of information in the level that help the user navigate or progress through the game. The one's I added to Resurgence used a specific font and had three sizes, they where placed in the level using a hammer entity and always faced the player.
sections: ["personal"]
---

World hints are snippets of information in the level that help the user navigate or progress through the game. The one's I added to Resurgence used a specific font and had three sizes, they where placed in the level using a hammer entity and always faced the player which is called billboarding.

So to implement this in your very own mod you first need to add the worldhint.cpp file for the server-side entity that's setup by hammer so that the level designer can create a worldhint entity with a font size, hint scale and the text for the hint itself.

```cpp
#include "cbase.h"

class CWorldHint : public CBaseEntity
{
public:
	DECLARE_CLASS( CWorldHint, CBaseEntity );
	DECLARE_SERVERCLASS();

	CWorldHint();
	void Spawn();
	void Activate();

	//Always send to all clients
	int UpdateTransmitState()
	{
		return SetTransmitState( FL_EDICT_ALWAYS );
	}

private:
	CNetworkString( hint, MAX_PATH );
	CNetworkVar( int, fontSize );
	CNetworkVar( float, scalar );

	string_t m_String_tHint;

protected:
	DECLARE_DATADESC();
};

LINK_ENTITY_TO_CLASS( worldhint, CWorldHint )

BEGIN_DATADESC( CWorldHint )
	DEFINE_KEYFIELD( m_String_tHint, FIELD_STRING, "Hint" ),
	DEFINE_KEYFIELD( fontSize, FIELD_INTEGER, "Size" ),
	DEFINE_KEYFIELD( scalar, FIELD_FLOAT, "Scalar" )
END_DATADESC()

IMPLEMENT_SERVERCLASS_ST( CWorldHint, DT_WorldHint )
	SendPropString( SENDINFO( hint ) ),
	SendPropInt( SENDINFO( fontSize ) ),
	SendPropFloat( SENDINFO( scalar ) ),
END_SEND_TABLE()

CWorldHint::CWorldHint()
{
	fontSize = 1;
	memset( hint.GetForModify(), 0, sizeof( hint ) );
}

void CWorldHint::Spawn()
{
	SetModelName( MAKE_STRING( "worldhint" ) );
	SetSolid( SOLID_NONE );
	SetMoveType( MOVETYPE_NONE );

	Precache();
	SetModel( STRING( GetModelName() ) );

	AddEffects( EF_NOSHADOW | EF_NORECEIVESHADOW );
}

void CWorldHint::Activate()
{
	BaseClass::Activate();
	Q_strncpy( hint.GetForModify(), STRING( m_String_tHint ), 255 );
}
```

This is a pretty basic entity setup, the only special thing it does is copy the hint text from hammer to the variable used to send the info over to the client. It also completely hides itself as it's clientside only. This following server-side code is only 200 lines long and does the rest, first it creates a VGUI panel then sets up correct angles and world position and then proceeds to render the VGUI element in the world using the magic function called [DrawPanelIn3DSpace]("https://developer.valvesoftware.com/wiki/IMatSystemSurface").

```cpp
#include "cbase.h"
#include "fmtstr.h"

//Vgui render stuff
#include "VGuiMatSurface/IMatSystemSurface.h"
#include <vgui_controls/Panel.h>
#include <vgui_controls/Label.h>
#include <vgui/ISurface.h>

//Debugging
#include "debugoverlay_shared.h"

//
//	Special hint panel used for drawing
//
class HintPanel : public vgui::Panel
{
public:
	HintPanel( const char *text, int fontSize ) : fontSize( fontSize )
	{
		SetVisible( true );
		SetPos( 0, 0 );

		//Create basic label
		label = new vgui::Label( this, "", text );
		label->SetPos( 0, 0 );
	}

	void ApplySchemeSettings( vgui::IScheme *pScheme )
	{
		//Get the font and set the label
		vgui::HFont textFont = pScheme->GetFont( CFmtStr( "WorldHint%i", fontSize ) );
		label->SetFont( textFont );

		//Get the labels text in wchar format
		wchar_t wText[256];
		label->GetText( wText, 256 );

		//Calculate the texts size
		int w, h;
		vgui::surface()->GetTextSize( textFont, wText, w, h );

		//Set the label and panels size to the texts size
		label->SetSize( w, h );
		SetSize( w, h );
	}

private:
	vgui::Label *label;
	int fontSize;
};

ConVar res_debug_worldhint( "res_debug_worldhint", "0" );
ConVar res_worldhint( "res_worldhint", "1" );

//
//	Client-side worldhint entity for rendering the actual hint
//
class C_WorldHint : public C_BaseEntity
{
public:
	DECLARE_CLASS( C_WorldHint, C_BaseEntity );
	DECLARE_CLIENTCLASS();

	C_WorldHint()
	{
		hintPanel = NULL;
	}

	virtual int DrawModel( int flags );
	virtual void OnDataChanged( DataUpdateType_t type );

	virtual void GetRenderBounds( Vector &vecMins, Vector &vecMaxs )
	{
		//Calculate the bounds for the hint
		Vector half = Vector( width/2.0f, width/2.0f, height/2.0f );
		vecMins.Init( -half.x, -half.y, -half.z );
		vecMaxs.Init( half.x, half.y, half.z );
		
		//Debug the bounds
		if( res_debug_worldhint.GetBool() )
			NDebugOverlay::Box( GetAbsOrigin(), vecMins, vecMaxs, 255, 0, 0, 128, 1.0f );
	}

	//Matrix stuff
	void ComputePanelToWorld();
	Vector CalculateOrigin( QAngle angles );
	QAngle CalculateAngle();

private:
	char hint[MAX_PATH];
	int fontSize;
	float scalar;
	VMatrix m_PanelToWorld;

	//Panel stuff
	float width, height;
	int pWidth, pHeight;
	HintPanel *hintPanel;
};

LINK_ENTITY_TO_CLASS( worldhint, C_WorldHint );

IMPLEMENT_CLIENTCLASS_DT( C_WorldHint, DT_WorldHint, CWorldHint )
	RecvPropString( RECVINFO( hint ) ),
	RecvPropInt( RECVINFO( fontSize ) ),
	RecvPropFloat( RECVINFO( scalar ) ),
END_RECV_TABLE()

void C_WorldHint::OnDataChanged( DataUpdateType_t type )
{
	//We have some data to use
	if( type == DATA_UPDATE_CREATED )
	{
		//Create the hint panel with our data
		hintPanel = new HintPanel( hint, fontSize );
		hintPanel->InvalidateLayout( true, true );//Setup scheme stuff
		hintPanel->GetSize( pWidth, pHeight );

		//
		width = (float)pWidth/scalar;
		height = (float)pHeight/scalar;
	}

	BaseClass::OnDataChanged( type );
}

Vector C_WorldHint::CalculateOrigin( QAngle angles )
{
	Vector vecOrigin = GetAbsOrigin();

	//Get the angle vectors
	Vector xaxis, yaxis;
	AngleVectors( angles, &xaxis, &yaxis, NULL );

	//Transform the x and y axis to center it
	VectorMA( vecOrigin, -(width/2), xaxis, vecOrigin );
	VectorMA( vecOrigin, -(height/2), yaxis, vecOrigin );

	//Return new origin
	return vecOrigin;
}

QAngle C_WorldHint::CalculateAngle()
{
	//Get the player
	C_BasePlayer *pLocalPlayer = C_BasePlayer::GetLocalPlayer();
	if( !pLocalPlayer )
		return vec3_angle;

	//Get the direction between this and the player
	Vector target = GetAbsOrigin()-(pLocalPlayer->GetAbsOrigin()+Vector(0,0,pLocalPlayer->GetPlayerMaxs().z/2));
	
	//Convert to angles
	QAngle angles;
	VectorAngles( target, angles );

	//Fix angles
	angles[YAW] += 90;
	angles[ROLL] = (-angles[PITCH])-90;
	angles[PITCH] = 180;
	
	//Return angles
	return angles;
}

void C_WorldHint::ComputePanelToWorld()
{
	//Get out angle and origin
	QAngle angles = CalculateAngle();
	Vector origin = CalculateOrigin( angles );

	//Set the matrix to them
	m_PanelToWorld.SetupMatrixOrgAngles( origin, angles );

	//Debug
	if( res_debug_worldhint.GetBool() )
	{
		NDebugOverlay::Box( GetAbsOrigin(), Vector( -2,-2,-2 ), Vector( 2, 2, 2 ), 0, 255, 0, 255, 0.01f );
		NDebugOverlay::Box( origin, Vector( -2,-2,-2 ), Vector( 2, 2, 2 ), 255, 0, 0, 255, 0.01f );
	}
}

int C_WorldHint::DrawModel( int flags )
{
	//Client doesn't want to render these
	if( !res_worldhint.GetBool() )
		return 0;

	//Wait for a panel to draw
	if( !hintPanel )
		return 0;

	//Calculate the origin and angles
	ComputePanelToWorld();

	//Draw the panel
	g_pMatSystemSurface->DrawPanelIn3DSpace( hintPanel->GetVPanel(), m_PanelToWorld, 
		pWidth, pHeight, width, height );

	return 1;
}
```
The source code is also available in this [Gist]("https://gist.github.com/tingtom/4b2240b1d681d1e59bdcd338b0823b91").
