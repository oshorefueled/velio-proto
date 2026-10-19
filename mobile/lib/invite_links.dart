import 'dart:async';

import 'package:app_links/app_links.dart';

class InviteLink {
  const InviteLink(this.code, {this.visitorId, this.visitId});
  final String code;
  final String? visitorId;
  final String? visitId;
}

/// Initial and warm installed-app links enter the same preview owner.
Future<StreamSubscription<Uri>> wireInviteLinks(
  void Function(InviteLink link) onLink,
) async {
  final links = AppLinks();
  void open(Uri? uri) {
    final link = inviteFromUri(uri);
    if (link != null) onLink(link);
  }

  final subscription = links.uriLinkStream.listen(open, onError: (_) {});
  try {
    open(await links.getInitialLink());
  } catch (_) {
    // Plain launch and unavailable platform routing retain manual entry.
  }
  return subscription;
}

InviteLink? inviteFromUri(Uri? uri) {
  if (uri == null || uri.scheme != 'velio') return null;
  String? code;
  if (uri.host == 'invite' && uri.pathSegments.length == 1) {
    code = uri.pathSegments.single;
  } else if (uri.host.isEmpty &&
      uri.pathSegments.length == 2 &&
      uri.pathSegments.first == 'invite') {
    code = uri.pathSegments.last;
  }
  if (code == null || code.trim().isEmpty) return null;
  final uuid = RegExp(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  );
  String? reference(String name) {
    final value = uri.queryParameters[name];
    return value != null && uuid.hasMatch(value) ? value : null;
  }

  return InviteLink(
    code.trim().toUpperCase(),
    visitorId: reference('visitorId'),
    visitId: reference('visitId'),
  );
}

String? codeFromUri(Uri? uri) => inviteFromUri(uri)?.code;
