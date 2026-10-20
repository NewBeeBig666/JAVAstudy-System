package com.la.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.la.entity.DailyActivity;
import com.la.entity.Mastery;
import com.la.mapper.DailyActivityMapper;
import com.la.mapper.MasteryMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;

@Service
@RequiredArgsConstructor
public class MasteryService {

    private final MasteryMapper masteryMapper;
    private final DailyActivityMapper dailyActivityMapper;

    /**
     * 掌握度回写：clamp(0,100, 旧值 + delta)，UPSERT
     *
     * @return 调整后的新掌握度
     */
    @Transactional
    public int adjust(Long userId, Long kpId, int delta) {
        Mastery m = masteryMapper.selectOne(new LambdaQueryWrapper<Mastery>()
                .eq(Mastery::getUserId, userId).eq(Mastery::getKpId, kpId));
        int old = m != null ? m.getMasteryValue() : 0;
        int value = Math.max(0, Math.min(100, old + delta));
        if (m == null) {
            m = new Mastery();
            m.setUserId(userId);
            m.setKpId(kpId);
            m.setMasteryValue(value);
            masteryMapper.insert(m);
        } else {
            m.setMasteryValue(value);
            masteryMapper.updateById(m);
        }
        return value;
    }

    /** 当前掌握度（只读，无记录返回 null 不创建记录）——做错不扣分场景使用 */
    public Integer currentValue(Long userId, Long kpId) {
        Mastery m = masteryMapper.selectOne(new LambdaQueryWrapper<Mastery>()
                .eq(Mastery::getUserId, userId).eq(Mastery::getKpId, kpId));
        return m != null ? m.getMasteryValue() : null;
    }

    /**
     * 记录当日学习时长（分钟），UPSERT 累加
     */
    @Transactional
    public void addMinutes(Long userId, int minutes) {
        LocalDate today = LocalDate.now();
        DailyActivity act = dailyActivityMapper.selectOne(new LambdaQueryWrapper<DailyActivity>()
                .eq(DailyActivity::getUserId, userId).eq(DailyActivity::getStatDate, today));
        if (act == null) {
            act = new DailyActivity();
            act.setUserId(userId);
            act.setStatDate(today);
            act.setMinutes(minutes);
            dailyActivityMapper.insert(act);
        } else {
            act.setMinutes(act.getMinutes() + minutes);
            dailyActivityMapper.updateById(act);
        }
    }
}
