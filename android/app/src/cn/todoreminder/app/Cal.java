package cn.todoreminder.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.CalendarContract;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 把日程写进手机系统日历。
 *
 * 为什么不在网页里做：安卓的系统日历不认 http://IP:端口 这种 .ics 订阅，
 * 绝大多数机型也没有「导入 ics」的入口 —— 那个链接在电脑上能用，在手机上就是个死链。
 * 只有拿到日历读写权限、直接往 CalendarContract 里 insert，日程才真的会出现在手机日历里。
 */
final class Cal {
    static final String TZ = "Asia/Shanghai";

    private Cal() {}

    /** 找一个能写的日历。国产 ROM 上通常有「本地日历」，没有的话退而求其次找任意可写的。 */
    static long writableCalendar(Context c) {
        String level = CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL + ">=500";
        long id = first(c, level + " AND " + CalendarContract.Calendars.VISIBLE + "=1");
        if (id > 0) return id;
        id = first(c, level);
        if (id > 0) return id;
        return -1;
    }

    private static long first(Context c, String selection) {
        ContentResolver cr = c.getContentResolver();
        Cursor cur = null;
        try {
            cur = cr.query(CalendarContract.Calendars.CONTENT_URI,
                    new String[]{CalendarContract.Calendars._ID}, selection, null, null);
            if (cur != null && cur.moveToNext()) return cur.getLong(0);
        } catch (Exception ignored) {
            // 权限被拒 / 某些 ROM 没有日历 Provider，都当没找到
        } finally {
            if (cur != null) cur.close();
        }
        return -1;
    }

    static int sync(Context c, long calId, String json) throws Exception {
        JSONArray arr = new JSONObject(json).optJSONArray("events");
        if (arr == null) return 0;
        int added = 0;

        for (int i = 0; i < arr.length(); i++) {
            JSONObject e = arr.optJSONObject(i);
            if (e == null) continue;
            long at = e.optLong("at", 0);
            if (at <= 0) continue;
            String title = e.optString("title", "提醒");
            long end = e.optLong("end", 0);
            if (end <= at) end = at + 30 * 60_000L;

            // 同一件事同步两次不该在日历里叠成一堆：按「日历+标题+开始时间」清掉旧的
            String where = CalendarContract.Events.CALENDAR_ID + "=? AND "
                    + CalendarContract.Events.TITLE + "=? AND "
                    + CalendarContract.Events.DTSTART + "=?";
            try {
                c.getContentResolver().delete(CalendarContract.Events.CONTENT_URI, where,
                        new String[]{String.valueOf(calId), title, String.valueOf(at)});
            } catch (Exception ignored) {
            }

            ContentValues cv = new ContentValues();
            cv.put(CalendarContract.Events.CALENDAR_ID, calId);
            cv.put(CalendarContract.Events.TITLE, title);
            cv.put(CalendarContract.Events.DESCRIPTION, e.optString("body", ""));
            cv.put(CalendarContract.Events.DTSTART, at);
            cv.put(CalendarContract.Events.DTEND, end);
            cv.put(CalendarContract.Events.EVENT_TIMEZONE, TZ);

            Uri uri = null;
            try {
                uri = c.getContentResolver().insert(CalendarContract.Events.CONTENT_URI, cv);
            } catch (Exception ignored) {
            }
            if (uri == null) continue;
            added++;

            // 提醒点也一起写进去，这份日历才会真的响；不然只是一条静态记录
            long evId;
            try {
                evId = Long.parseLong(uri.getLastPathSegment());
            } catch (Exception ex) {
                continue;
            }
            JSONArray alarms = e.optJSONArray("alarms");
            int put = 0;
            for (int k = 0; alarms != null && k < alarms.length() && put < 3; k++) {
                int m = alarms.optInt(k, -1);
                if (m < 0 || m > 20160) continue;
                ContentValues rv = new ContentValues();
                rv.put(CalendarContract.Reminders.EVENT_ID, evId);
                rv.put(CalendarContract.Reminders.MINUTES, m);
                rv.put(CalendarContract.Reminders.METHOD, CalendarContract.Reminders.METHOD_ALERT);
                try {
                    c.getContentResolver().insert(CalendarContract.Reminders.CONTENT_URI, rv);
                    put++;
                } catch (Exception ignored) {
                }
            }
            if (put > 0) {
                ContentValues has = new ContentValues();
                has.put(CalendarContract.Events.HAS_ALARM, 1);
                try {
                    c.getContentResolver().update(uri, has, null, null);
                } catch (Exception ignored) {
                }
            }
        }
        return added;
    }
}
