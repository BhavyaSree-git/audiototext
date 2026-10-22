"""Browser regression test with a simulated API; does not change SD-card files."""
import json
from playwright.sync_api import sync_playwright, expect


def main():
    files = [{"name": "REC0002.wav", "size": 200, "duration": "00:00:02"},
             {"name": "REC0001.wav", "size": 100, "duration": "00:00:01"},
             {"name": "._REC0001.wav", "size": 4096}]
    calls, jobs, polls, errors = [], {}, {}, []
    recording = False
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        page = browser.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))

        def route_api(route):
            nonlocal recording
            request = route.request
            path = request.url.split("/api/", 1)[1].split("?", 1)[0]
            calls.append((request.method, path))
            result = {}
            if path == "status":
                result = {"name": "Test ESP32", "sdReady": True, "recording": recording, "storage": {"used": 300, "total": 1000}}
            elif path == "files":
                result = {"files": files}
            elif path.endswith("/transcribe"):
                filename = path.split("/")[1]
                job = filename
                jobs[job] = filename
                result = {"jobId": job}
            elif path.startswith("transcriptions/"):
                job = path.split("/")[1]
                polls[job] = polls.get(job, 0) + 1
                if job == "REC0002.wav" and polls[job] < 3:
                    result = {"status": "processing", "message": "Testing selected-file isolation"}
                else:
                    result = {"status": "completed", "text": "Transcript for " + job, "language": "en",
                              "audio": {"rawUrl": "/api/audio/test/raw.wav", "enhancedUrl": "/api/audio/test/clear.wav", "channels": 4, "selectedChannel": 2}}
            elif path == "record/start":
                recording = True
                result = {"recording": True, "file": "REC0003.wav"}
            elif path == "record/stop":
                recording = False
                result = {"recording": False, "saved": True, "file": "REC0003.wav"}
            elif path == "record/save":
                files.insert(0, {"name": "REC0003.wav", "size": 300})
                result = {"saved": True, "file": "REC0003.wav"}
            elif request.method == "DELETE":
                name = path.split("/")[1]
                files[:] = [file for file in files if file["name"] != name]
                result = {"deleted": True}
            elif path.endswith("/download"):
                route.fulfill(status=200, headers={"Content-Disposition": "attachment; filename=recording.wav"}, content_type="audio/wav", body=b"test")
                return
            route.fulfill(status=200, content_type="application/json", body=json.dumps(result))

        page.route("**/api/**", route_api)
        page.goto("http://localhost:8765")
        page.locator("[data-go-login]").first.click()
        page.locator("#username").fill("admin")
        page.locator("#password").fill("admin")
        page.locator("#login-form button").click()
        page.locator("#sync-button").click()
        expect(page.locator("#stat-recordings")).to_have_text("2")
        expect(page.locator("#latest-filename")).to_have_text("REC0002.wav")
        page.locator("#recent-files tr").filter(has_text="REC0001.wav").get_by_role("button", name="Convert", exact=True).click()
        expect(page.locator("#latest-transcript-text")).to_have_text("Transcript for REC0001.wav", timeout=15000)
        page.wait_for_timeout(10000)
        expect(page.locator("#latest-filename")).to_have_text("REC0001.wav")
        expect(page.locator("#latest-transcript-text")).to_have_text("Transcript for REC0001.wav")
        expect(page.locator("#enhanced-audio")).to_be_visible()
        with page.expect_download():
            page.locator("#recent-files tr").filter(has_text="REC0001.wav").get_by_role("button", name="Download", exact=True).click()
        page.locator("#start-record").click()
        expect(page.locator("#recording-tag")).to_contain_text("RECORDING")
        page.locator("#stop-save-record").click()
        expect(page.locator("#latest-filename")).to_have_text("REC0003.wav")
        expect(page.locator("#latest-transcript-text")).to_have_text("Transcript for REC0003.wav", timeout=15000)
        expect(page.locator("#stop-save-record")).to_be_disabled()
        page.on("dialog", lambda dialog: dialog.accept())
        page.locator("#recent-files tr").filter(has_text="REC0001.wav").get_by_role("button", name="Delete", exact=True).click()
        expect(page.locator("#stat-recordings")).to_have_text("2")
        assert ("POST", "record/start") in calls
        assert ("POST", "record/stop") in calls
        assert ("POST", "record/save") in calls
        assert ("DELETE", "files/REC0001.wav") in calls
        assert not errors, errors
        browser.close()
    print("Browser workflow passed: sync, latest conversion, selected-file isolation, playback, download, record/save/convert, SD deletion request.")


if __name__ == "__main__":
    main()
