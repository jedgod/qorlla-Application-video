// App.js
// Expo SDK 59 / React Native compatible version

import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { io } from 'socket.io-client';

const BACKEND_URL =
  Platform.OS === 'android'
    ? 'http://10.0.2.2:5000' // Android emulator
    : 'http://localhost:5000'; // iOS simulator / web
// For physical device use: http://YOUR_LOCAL_IP:5000

export default function App() {
  const [meetingId, setMeetingId] = useState('858 9833 3712');
  const [inRoom, setInRoom] = useState(false);
  const [chatMessage, setChatMessage] = useState('');
  const [chatLog, setChatLog] = useState([]);
  const [participants, setParticipants] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [userId] = useState(`mob_user_${Math.random().toString(36).slice(2, 8)}`);

  const socketRef = useRef(null);

  useEffect(() => {
    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, []);

  const handleJoinRoom = async () => {
    if (!meetingId.trim()) {
      Alert.alert('Validation Error', 'Please supply a target meeting tracking token.');
      return;
    }

    try {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }

      const socket = io(BACKEND_URL, {
        transports: ['websocket'],
        forceNew: true,
      });

      socketRef.current = socket;

      socket.on('connect', () => {
        console.log('[Expo Mobile]: WebSocket connected');

        socket.emit('join_room', {
          meetingId: meetingId.trim(),
          userId,
          userName: 'Mobile Participant',
          userRole: 'participant',
        });

        setInRoom(true);
      });

      socket.on('room_state_updated', (data) => {
        setParticipants(data?.participants || []);
        if (data?.meetingMetadata?.chatHistory) {
          setChatLog(data.meetingMetadata.chatHistory);
        }
      });

      socket.on('chat_message_received', (msgPayload) => {
        setChatLog((prev) => [...prev, msgPayload]);
      });

      socket.on('document_registry_updated', (docsArray) => {
        setDocuments(docsArray || []);
      });

      socket.on('meeting_terminated_by_host', (payload) => {
        Alert.alert('Session Concluded', payload?.summaryMessage || 'The host ended the meeting.');
        leaveActiveRoom();
      });

      socket.on('connect_error', () => {
        Alert.alert(
          'Network Timeout',
          'Unable to connect. Check your backend URL and local network settings.'
        );
        leaveActiveRoom();
      });

      socket.on('disconnect', () => {
        console.log('[Expo Mobile]: socket disconnected');
      });
    } catch (err) {
      Alert.alert('Error', 'Failed to initialize mobile signaling sequence.');
    }
  };

  const leaveActiveRoom = () => {
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }

    setInRoom(false);
    setChatLog([]);
    setParticipants([]);
    setDocuments([]);
    setChatMessage('');
  };

  const dispatchMobileChatMessage = () => {
    if (!chatMessage.trim() || !socketRef.current) return;

    socketRef.current.emit('send_chat_message', {
      messageText: chatMessage.trim(),
    });

    setChatMessage('');
  };

  const renderMessage = ({ item, index }) => (
    <View style={styles.messageBubble}>
      <Text style={styles.msgSender}>{item?.senderName || 'Unknown user'}</Text>
      <Text style={styles.msgBody}>{item?.message || item?.messageText || ''}</Text>
    </View>
  );

  if (!inRoom) {
    return (
      <SafeAreaView style={styles.entryContainer}>
        <StatusBar barStyle="dark-content" />
        <View style={styles.card}>
          <Text style={styles.brandTitle}>
            zoom<Text style={styles.brandLight}> mobile</Text>
          </Text>

          <Text style={styles.subtitle}>Enter meeting identifier details below</Text>

          <TextInput
            style={styles.input}
            value={meetingId}
            onChangeText={setMeetingId}
            placeholder="e.g. 858 9833 3712"
            placeholderTextColor="#94A3B8"
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Pressable style={styles.btnPrimary} onPress={handleJoinRoom}>
            <Text style={styles.btnText}>Join Workspace Room</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.liveRoomContainer}>
      <StatusBar barStyle="light-content" />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 8 : 0}
      >
        <View style={styles.roomHeader}>
          <View style={styles.headerTextWrap}>
            <Text style={styles.roomTitle} numberOfLines={1}>
              Thesis Research Room
            </Text>
            <Text style={styles.roomMeta}>
              {participants.length} Active Participants online · {documents.length} Docs
            </Text>
          </View>

          <Pressable style={styles.btnLeave} onPress={leaveActiveRoom}>
            <Text style={styles.btnLeaveText}>Leave</Text>
          </Pressable>
        </View>

        <FlatList
          data={chatLog}
          keyExtractor={(item, index) => item?.id?.toString?.() || `msg-${index}`}
          style={styles.chatFeed}
          contentContainerStyle={styles.chatFeedContent}
          renderItem={renderMessage}
          keyboardShouldPersistTaps="handled"
        />

        <View style={styles.inputDock}>
          <TextInput
            style={styles.dockInput}
            value={chatMessage}
            onChangeText={setChatMessage}
            placeholder="Type message text here..."
            placeholderTextColor="#94A3B8"
            autoCorrect={false}
          />

          <Pressable style={styles.btnSend} onPress={dispatchMobileChatMessage}>
            <Text style={styles.btnSendText}>Send</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },

  entryContainer: {
    flex: 1,
    backgroundColor: '#F8FAFC',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },

  card: {
    width: '100%',
    maxWidth: 420,
    padding: 24,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },

  brandTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: '#0B5CFF',
    textAlign: 'center',
    letterSpacing: -1,
  },

  brandLight: {
    color: '#64748B',
    fontWeight: '400',
    fontSize: 16,
  },

  subtitle: {
    fontSize: 13,
    color: '#64748B',
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 24,
  },

  input: {
    height: 48,
    borderColor: '#CBD5E1',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 16,
    fontSize: 15,
    color: '#1E293B',
    backgroundColor: '#F8FAFC',
    marginBottom: 16,
    fontFamily: Platform.select({
      ios: 'Courier',
      android: 'monospace',
      default: 'monospace',
    }),
  },

  btnPrimary: {
    height: 48,
    backgroundColor: '#0B5CFF',
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },

  btnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },

  liveRoomContainer: {
    flex: 1,
    backgroundColor: '#1E293B',
  },

  roomHeader: {
    minHeight: 64,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#0F172A',
    gap: 12,
  },

  headerTextWrap: {
    flex: 1,
    minWidth: 0,
  },

  roomTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#F8FAFC',
  },

  roomMeta: {
    fontSize: 11,
    color: '#94A3B8',
    marginTop: 2,
  },

  btnLeave: {
    backgroundColor: '#EF4444',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },

  btnLeaveText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
  },

  chatFeed: {
    flex: 1,
    backgroundColor: '#0F172A',
  },

  chatFeedContent: {
    padding: 16,
  },

  messageBubble: {
    backgroundColor: '#1E293B',
    padding: 12,
    borderRadius: 8,
    marginBottom: 10,
    alignSelf: 'flex-start',
    maxWidth: '85%',
  },

  msgSender: {
    fontSize: 11,
    fontWeight: '700',
    color: '#38BDF8',
    marginBottom: 2,
  },

  msgBody: {
    fontSize: 14,
    color: '#E2E8F0',
  },

  inputDock: {
    padding: 12,
    backgroundColor: '#0F172A',
    borderTopWidth: 1,
    borderTopColor: '#334155',
    flexDirection: 'row',
    alignItems: 'center',
  },

  dockInput: {
    flex: 1,
    minHeight: 40,
    backgroundColor: '#1E293B',
    borderRadius: 20,
    paddingHorizontal: 16,
    color: '#F8FAFC',
    fontSize: 14,
    marginRight: 8,
  },

  btnSend: {
    paddingHorizontal: 16,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },

  btnSendText: {
    color: '#38BDF8',
    fontSize: 14,
    fontWeight: '600',
  },
});