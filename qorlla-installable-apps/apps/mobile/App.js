import React from 'react';
import { SafeAreaView, Text, View, Pressable, StyleSheet, Alert, Linking } from 'react-native';
import { StatusBar } from 'expo-status-bar';
const base = process.env.EXPO_PUBLIC_QORLLA_URL;
function launch(path) {
  if (!base || !/^https:\/\//i.test(base)) return Alert.alert('Setup required', 'Configure EXPO_PUBLIC_QORLLA_URL with your verified Qorlla HTTPS URL.');
  const url = new URL(path, base).toString();
  Linking.openURL(url).catch(() => Alert.alert('Unavailable', 'Unable to open Qorlla.'));
}
export default function App() { return <SafeAreaView style={s.root}><StatusBar style="light"/><View style={s.header}><Text style={s.brand}>Qorlla</Text><Text style={s.sub}>Meet. Connect. Work.</Text></View><Text style={s.title}>Welcome to Qorlla</Text><Text style={s.body}>Connect to your Qorlla account and meetings securely.</Text>{[['Sign in','/auth/login'],['Join meeting','/guest/join-meeting'],['Continue as guest','/guest/welcome'],['Help & support','/guest/help']].map(([label,path])=><Pressable accessibilityRole="button" key={label} style={s.button} onPress={()=>launch(path)}><Text style={s.buttonText}>{label}</Text></Pressable>)}<Text style={s.note}>Calls and messaging require the certified Qorlla services. This starter opens the verified web experience.</Text></SafeAreaView> }
const s=StyleSheet.create({root:{flex:1,backgroundColor:'#0c1527',padding:24},header:{paddingTop:45,paddingBottom:42},brand:{fontSize:36,color:'#fff',fontWeight:'800'},sub:{color:'#93b2da',marginTop:8},title:{fontSize:24,color:'#fff',fontWeight:'700'},body:{color:'#b7c8df',marginTop:12,marginBottom:24},button:{backgroundColor:'#2766dc',padding:17,borderRadius:12,marginBottom:12},buttonText:{color:'#fff',fontWeight:'700',textAlign:'center'},note:{color:'#91a5c4',fontSize:12,marginTop:24,lineHeight:19}});
