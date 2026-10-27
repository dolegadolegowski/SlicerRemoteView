// C# conformance run for the generated protocol types (PRO-17). Hand-written; built and run by
// `npm run check:cs -w shared` (shared/scripts/build-cs.mjs) against shared/cs/RemoteView.Protocol/*.cs.
//
// 1. Every valid fixture of shared/fixtures/messages deserialises into the class MessageTypes.Classes names for its
//    directory, with MissingMemberHandling.Error (so a schema property missing from the class fails), and serialises
//    back to the same JSON (null-valued properties are ignored on both sides: optional ones are omitted by the DTOs, required nullable ones are written as null).
// 2. Behaviour the plan requires: unknown enum values map to Other (§14), unknown fields are tolerated, `Type` is
//    pre-set on every class, plain JsonConvert works without quicktype's internal Settings, null optionals are omitted.
//
// Output lists fixture file names only, never message contents (fixtures carry fake codes, but the habit stays).
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using RemoteView.Protocol;

internal static class Program
{
    private static readonly List<string> Failures = new List<string>();
    private static int checks;

    private static void Check(bool condition, string what)
    {
        checks++;
        if (!condition) Failures.Add(what);
    }

    /// <summary>Drops null properties and turns every number into a double (JToken.DeepEquals tells 1 from 1.0).</summary>
    private static void Normalize(JToken token)
    {
        if (token is JObject obj)
        {
            foreach (var property in obj.Properties().ToList())
            {
                if (property.Value.Type == JTokenType.Null) property.Remove();
                else if (property.Value.Type == JTokenType.Integer || property.Value.Type == JTokenType.Float)
                    property.Value = new JValue(property.Value.Value<double>());
                else Normalize(property.Value);
            }
        }
        else if (token is JArray array)
        {
            foreach (var item in array.ToList())
            {
                if (item.Type == JTokenType.Integer || item.Type == JTokenType.Float)
                    item.Replace(new JValue(item.Value<double>()));
                else Normalize(item);
            }
        }
    }

    private static int Main(string[] args)
    {
        if (args.Length != 1)
        {
            Console.Error.WriteLine("usage: conformance <shared/fixtures directory>");
            return 2;
        }

        var strict = new JsonSerializerSettings
        {
            MissingMemberHandling = MissingMemberHandling.Error,
            DateParseHandling = DateParseHandling.None,
        };
        var messagesDir = Path.Combine(args[0], "messages");
        var fixtureCount = 0;
        foreach (var typeDir in Directory.GetDirectories(messagesDir).OrderBy(d => d, StringComparer.Ordinal))
        {
            var messageType = Path.GetFileName(typeDir);
            if (!MessageTypes.Classes.TryGetValue(messageType, out var cls))
            {
                Check(false, "no class registered for message type " + messageType);
                continue;
            }

            foreach (var file in Directory.GetFiles(typeDir, "valid-*.json").OrderBy(f => f, StringComparer.Ordinal))
            {
                fixtureCount++;
                var label = messageType + "/" + Path.GetFileName(file);
                try
                {
                    var text = File.ReadAllText(file);
                    var original = JToken.Parse(text);
                    var instance = JsonConvert.DeserializeObject(text, cls, strict);
                    Check(instance != null && instance.GetType() == cls, label + ": wrong class");
                    var again = JToken.Parse(JsonConvert.SerializeObject(instance));
                    Normalize(original);
                    Normalize(again);
                    Check(JToken.DeepEquals(original, again), label + ": round trip differs");
                }
                catch (Exception e)
                {
                    Check(false, label + ": " + e.GetType().Name + " " + e.Message.Split('\n')[0]);
                }
            }
        }

        Check(fixtureCount > 0, "no valid fixtures found in " + messagesDir);
        Check(MessageTypes.Classes.Count == 28, "expected 28 message classes, got " + MessageTypes.Classes.Count);

        foreach (var entry in MessageTypes.Classes)
        {
            var created = Activator.CreateInstance(entry.Value);
            var type = entry.Value.GetProperty("Type")?.GetValue(created) as string;
            Check(type == entry.Key, entry.Value.Name + ".Type default is not " + entry.Key);
        }

        try
        {
            BehaviourChecks();
        }
        catch (Exception e)
        {
            Check(false, "behaviour checks aborted: " + e.GetType().Name + " " + e.Message.Split('\n')[0]);
        }

        Console.WriteLine($"C# conformance: {fixtureCount} valid fixtures, {checks} checks, {Failures.Count} failure(s)");
        foreach (var failure in Failures) Console.Error.WriteLine("FAIL " + failure);
        return Failures.Count == 0 ? 0 : 1;
    }

    private static void BehaviourChecks()
    {
        // §14: unknown enum values and fields do not break a 1.0 client.
        var future = JsonConvert.DeserializeObject<ErrorMessage>(
            "{\"protocolVersion\":\"1.9\",\"type\":\"error\",\"code\":\"FUTURE_CODE\",\"message\":\"m\",\"extra\":{\"a\":1}}");
        Check(future != null && future.Code == ErrorCode.Other, "unknown error code does not map to Other");
        Check(JsonConvert.DeserializeObject<SceneRequest>(
            "{\"protocolVersion\":\"1.0\",\"type\":\"scene.request\",\"reason\":\"FUTURE\"}")?.Reason == SceneRequestReason.Other,
            "unknown scene.request reason does not map to Other");
        Check(JsonConvert.DeserializeObject<Platform>("\"quest-browser\"") == Platform.QuestBrowser, "platform quest-browser");
        Check(JsonConvert.DeserializeObject<Platform>("\"hololens\"") == Platform.Other, "unknown platform does not map to Other");
        Check(JsonConvert.DeserializeObject<ErrorMessage>(
            "{\"protocolVersion\":\"1.0\",\"type\":\"error\",\"code\":\"SESSION_FULL\",\"message\":\"m\"}")?.Code == ErrorCode.SessionFull,
            "SESSION_FULL");
        var threw = false;
        try { JsonConvert.SerializeObject(new ErrorMessage { Code = ErrorCode.Other }); }
        catch (Exception e) when (e is InvalidOperationException || e is JsonException || e.GetType() == typeof(Exception)) { threw = true; }
        Check(threw, "writing ErrorCode.Other must throw (receive-only fallback)");

        // Sending side: camelCase names, null optionals omitted, plain JsonConvert.
        var join = new ViewerJoin
        {
            ProtocolVersion = "1.0",
            Code = "ABCDE",
            ClientInfo = new ClientInfo { App = "quest-app", Version = "0.1.0", Platform = "quest3" },
        };
        var joinJson = JObject.Parse(JsonConvert.SerializeObject(join));
        Check((string)joinJson["type"] == "viewer.join", "ViewerJoin.type");
        Check(!joinJson.ContainsKey("sessionId") && !joinJson.ContainsKey("viewerToken"), "null optionals are omitted");
        Check((string)joinJson["clientInfo"]["platform"] == "quest3", "clientInfo.platform stays a string");
    }
}
